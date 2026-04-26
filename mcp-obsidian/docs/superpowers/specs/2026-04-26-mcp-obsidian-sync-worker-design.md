# mcp-obsidian — Sync Worker (substituição do brain-sync.sh)

**Data:** 2026-04-26
**Status:** Spec aprovada, pendente plano de implementação
**Autor:** Renato + Claude
**Escopo:** Plan 8 — fora das Plans 1-7 (spec original 2026-04-15)

## 1. Motivação

A topologia atual do vault `fama-brain` tem dois escritores convergindo num hub GitHub:

```
Renato (Obsidian + plugin Git, auto-push) ──┐
                                            ├──► GitHub (origin/main)
VPS MCP (write FS) → cron 5min push ────────┘
```

Quatro modos de falha decorrentes deste design hoje:

| # | Falha | Janela atual | Severidade |
|---|---|---|---|
| 1 | Stale ownership/index no MCP após edição do Renato | até 5min para cron puxar **+ infinito** até MCP fazer write/restart (rebuild só no boot) | **Alta** — silenciosa, decisões de ownership baseadas em regra desatualizada |
| 2 | Janela de perda VPS entre write MCP e push do cron | até 5min | Média |
| 3 | Conflito real (mesma linha) entre Renato e MCP | depende do `--autostash` salvar — pode silenciosamente perder trabalho no stash | Baixa-média (raro, paths disjuntos) |
| 4 | Histórico GitHub dominado por commits "auto: sync" sem semântica | sempre | Baixa |

A causa raiz comum: **a lógica de sync vive fora do processo MCP** (cron de host), o que impede invalidação reativa de índice e granularidade semântica de commits.

### 1.1 Critérios de sucesso

1. Janela de propagação **MCP → Renato** ≤ 60s (hoje: até 5min).
2. Janela de propagação **Renato → MCP** com índice atualizado ≤ 60s (hoje: até 5min + infinito).
3. Histórico GitHub passa a ter 1 commit por operação MCP, com mensagem semântica.
4. Latência de write tools no MCP **não regride** (mantém ~3ms).
5. Conflitos remoto×local resolvidos automaticamente com política determinística e auditável.

### 1.2 Não-objetivos

- Suportar múltiplas réplicas do MCP (continua single-replica conforme `docker-compose.yml`).
- Substituir o cron `brain-sync.sh` totalmente — **mantido como safety-net** rodando 1x/dia.
- Persistir a fila de commits em disco (cobertura via safety-net).
- Suportar mudança de branch ou múltiplos remotes.
- Resolver conflitos no nível de linha (granularidade é arquivo).

## 2. Arquitetura

### 2.1 Visão geral

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Server (Express + StreamableHTTPServerTransport)        │
│                                                              │
│  Tools (write):                                              │
│    1. atomic FS write          (~3ms, igual hoje)            │
│    2. CommitQueue.enqueue()    (não-bloqueante, ~<1ms)       │
│    3. retorna pro caller                                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  SyncWorker (loop interno, intervalo 30s)            │  │
│  │                                                       │  │
│  │   1. git fetch origin main                           │  │
│  │   2. detectar overlap remote×queue                   │  │
│  │      a. sem overlap → pull --rebase --autostash      │  │
│  │      b. com overlap → snapshot + reset --hard +      │  │
│  │                       restore overlap (MCP wins)     │  │
│  │   3. index.refreshPaths(remote_changed)              │  │
│  │   4. drenar queue: 1 commit por job                  │  │
│  │   5. git push origin main                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ SSH (deploy key)
                              ▼
                          GitHub (origin/main)
                              ▲
                              │
                              │ Obsidian-Git plugin (auto-push)
                              │
                          Renato (Mac/iPad, vault local)


[Host VPS — fora do container]
  cron 1x/dia: brain-sync.sh (safety-net) → git pull --rebase --autostash
```

### 2.2 Componentes

#### 2.2.1 `CommitQueue` — `src/vault/commit-queue.ts` (novo)

In-memory FIFO. Sem persistência em disco (justificado em §6.1).

```ts
export interface CommitJob {
  path: string;          // rel path, ex: "_agents/reno/decisions.md"
  message: string;       // ex: "[mcp] append_decision: _agents/reno/decisions.md"
  enqueuedAt: number;
  as_agent: string;      // pra audit
  tool: string;          // pra audit
}

export class CommitQueue {
  enqueue(job: Omit<CommitJob, 'enqueuedAt'>): void;
  shift(): CommitJob | undefined;
  size(): number;
  pendingPaths(): Set<string>;        // detecta overlap em tick
  drain(): CommitJob[];                // pra graceful shutdown
}
```

Sem deduplicação: 2 writes seguidos no mesmo arquivo geram 2 commits — proposital, preserva história.

#### 2.2.2 `SyncWorker` — `src/vault/sync-worker.ts` (novo)

Loop principal com `setInterval`. Reentrancy guard via flag booleana (impede tick novo concorrente se um demora >30s).

Adicionalmente, um **mutex de resolução** (`resolutionLock`, `AsyncLock` simples ou flag + Promise) é acquirido pelo worker apenas durante a fase de conflito (snapshot → reset → restore). Tools de write fazem `await resolutionLock.acquire()` antes do `writeFileAtomic` e liberam após `queue.enqueue`; se o worker estiver em conflito, a tool aguarda (tipicamente <200ms; pior caso configurável). Isso impede que uma escrita de tool seja silenciosamente sobrescrita pelo `reset --hard` da resolução.

```ts
export interface SyncWorkerOptions {
  intervalMs: number;        // default 30_000
  remote: string;            // 'origin'
  branch: string;            // 'main'
}

export class SyncWorker {
  constructor(
    opts: SyncWorkerOptions,
    queue: CommitQueue,
    git: GitOps,
    index: VaultIndex,
    fs: { read: (rel: string) => Promise<string>; write: (rel: string, content: string) => Promise<void> },
  );
  
  start(): void;
  stop(): Promise<void>;        // SIGTERM/SIGINT — drena fila, push final, clearInterval
  getStatus(): SyncWorkerStatus;
  private async tick(): Promise<void>;
  private async resolveOverlap(remoteChanged: string[], overlap: string[]): Promise<void>;
}

export interface SyncWorkerStatus {
  queueSize: number;
  lastTickAt: string | null;
  lastTickOutcome: 'ok' | 'conflict_resolved' | 'push_failed_retry' | 'rebase_failed' | 'fetch_failed' | null;
  lastError: string | null;
  lastConflict: { at: string; files: string[]; remote_sha: string; mcp_paths_kept: string[] } | null;
  totalTicks: number;
  totalCommitsPushed: number;
  totalConflictsResolved: number;
}
```

Status exposto via `/health` (campos novos) e via novo resource opcional `obsidian://sync` (decisão posterior, fora desta spec).

#### 2.2.3 `GitOps` estendido — `src/vault/git.ts`

```ts
export class GitOps {
  // existentes:
  status(): Promise<StatusResult>;
  head(): Promise<string | null>;
  
  // novos:
  fetch(remote: string, branch: string): Promise<void>;
  isLocalBehind(remote: string, branch: string): Promise<boolean>;
  diffNames(from: string, to: string): Promise<string[]>;       // 'HEAD'..'origin/main'
  pullRebase(remote: string, branch: string): Promise<void>;     // throws on conflict
  rebaseAbort(): Promise<void>;
  resetHard(ref: string): Promise<void>;
  add(path: string): Promise<void>;
  commit(message: string): Promise<{ sha: string } | null>;       // null se nada a commitar
  push(remote: string, branch: string): Promise<{ ok: true } | { ok: false; reason: 'non-fast-forward' | 'network' | 'auth' | 'unknown'; detail: string }>;
}
```

Erros mapeados para estados estruturados — `push` não lança em falhas esperadas; o worker decide retry.

#### 2.2.4 `VaultIndex.refreshPaths(paths)` — extensão de `src/vault/index.ts`

```ts
async refreshPaths(paths: string[]): Promise<void> {
  for (const rel of paths) {
    this.removeEntry(rel);
    const abs = path.join(this.vaultRoot, rel);
    let st;
    try { st = await fsp.stat(abs); }
    catch { continue; }   // arquivo deletado remotamente — só remoção
    await this.indexFile(abs, st.mtimeMs, st.size);
  }
}
```

Custo O(N_changed) em vez de O(N_total). Se o arquivo `_shared/context/AGENTS.md` está em `paths`, o `OwnershipResolver` invalida automaticamente via mtime check do próximo `resolve()`.

### 2.3 Fluxo de dados

#### 2.3.1 Tool de write (happy path)

```
agente → tool_call(write_note)
  → safeJoin(...)
  → ownerCheck(...)        ← já usa index atual; se Renato editou AGENTS.md, o pull mais recente já refrescou
  → await resolutionLock.acquire(path)   ← noop se worker não está em conflito
  → writeFileAtomic(...)   ~1-3ms
  → index.updateAfterWrite(...)
  → queue.enqueue({ path, message: "[mcp] write_note: <path>", as_agent, tool: 'write_note' })
  → resolutionLock.release(path)
  → setLastWriteTs()
  → log audit
  → retorna { path, created } pro agente
```

Total: ~3-5ms no caso normal (igual hoje + ~<1ms da enqueue + lock acquire é noop). Caso o worker esteja em conflito quando a tool tenta escrever: tool aguarda até o `resolutionLock.release()` (tipicamente <200ms; pior caso ~500ms se conflito grande).

#### 2.3.2 Tick do worker — fluxo sem overlap

```
t=0    : worker.tick() inicia
t=50ms : git fetch origin main (rede; pode ser 50-300ms)
t=300  : verificar HEAD..origin/main → 2 commits novos do Renato
t=310  : remoteChanged = ['_shared/context/fama/visao.md', '_shared/context/fama/operacao.md']
t=315  : ourTouched = queue.pendingPaths() ∪ git_diff_names('origin/main..HEAD')
         overlap = remoteChanged ∩ ourTouched = ∅
t=320  : git pull --rebase --autostash → apply 2 commits
t=600  : index.refreshPaths(remoteChanged) → reindex 2 arquivos
t=605  : drenar fila (3 jobs):
           git add <path> && git commit -m "[mcp] <tool>: <path>"  ×3
t=900  : git push origin main → 200-500ms
t=1300 : tick OK, status atualizado
```

**Definição precisa de `ourTouched`:** união de (a) paths na fila ainda não-commitados + (b) paths em commits locais já feitos mas não pushed (`git diff --name-only origin/main..HEAD`). Ambos representam intenções do MCP que devem prevalecer em caso de conflito; (b) cobre o cenário "tick anterior commitou, push falhou, próximo tick começa com queue vazia".

#### 2.3.3 Tick com overlap (conflito MCP × Renato)

```
Cenário: MCP enfileirou write em '_shared/context/fama/visao.md' às 10:00:15.
         Renato editou o mesmo arquivo no Obsidian, plugin pushou às 10:00:30.
         Worker tick às 10:00:30:

1. git fetch                                            → origin/main tem 1 commit novo
2. remoteChanged = ['_shared/context/fama/visao.md']
3. ourTouched = queue.pendingPaths() ∪ git diff --name-only origin/main..HEAD
              = {'_shared/context/fama/visao.md', ...}
4. overlap = remoteChanged ∩ ourTouched = ['_shared/context/fama/visao.md']
5. resolveOverlap(remoteChanged, overlap):
   a. acquire(resolutionLock)                ← bloqueia novas writes pra paths em overlap
   b. snapshot = { p: readFile(p) for p in overlap }    ← lê do FS (versão MCP)
   c. git rebase --abort (caso tenha rebase em curso)
   d. git reset --hard origin/main           ← FS adota versão Renato
   e. para cada (path, content) em snapshot:
        writeFileAtomic(path, content)        ← restaura versão MCP
   f. release(resolutionLock)
   g. index.refreshPaths(remoteChanged - overlap) = []   ← nada a refrescar
   h. log({ level: 'warn', component: 'sync-worker', event: 'conflict_resolved',
            files: ['visao.md'],
            remote_sha_overridden: <sha>,
            mcp_paths_kept: ['visao.md'] })
   i. // arquivos em overlap já têm conteúdo correto no FS; precisam ser stagedde novo
   //    (reset --hard limpou o staging). Re-enfileirar pra commit:
   for p in overlap if p not in queue.pendingPaths(): queue.enqueue({path: p,
       message: "[mcp] resolve_conflict: <p> (kept local over remote <short-sha>)",
       as_agent: 'sync-worker', tool: 'sync-worker'})
6. drenar fila → git add <p> && git commit -m "<msg>" pra cada job
7. git push                                              → fast-forward OK
```

**Política deliberada:** "MCP wins por arquivo" — para arquivos onde MCP tem write pendente, a versão do MCP prevalece. Para outros arquivos modificados remotamente, a versão remota é aplicada normalmente. Nunca há merge a nível de linha.

**Justificativa:** o agente do MCP toma decisões baseadas em estado consistente (ownership, índice). Se uma escrita do agente é silenciosamente sobreposta por edição manual, o agente não tem como saber. O inverso (Renato perder uma linha que digitou) também é ruim, mas é detectável: Renato vê seu commit "desaparecer" do diff e investiga via `git log`. O log estruturado do worker (item 5g) registra o `remote_sha_overridden` permitindo recuperação.

#### 2.3.4 Tick com falhas

| Falha | Comportamento |
|---|---|
| `git fetch` falha (rede) | log warn; pula resto do tick; próximo tick tenta de novo |
| `git pull --rebase` falha sem conflito (improvável) | log error + status `rebase_failed`; pula resto; próximo tick |
| `git push` falha por `non-fast-forward` | log info; deixa commits locais; próximo tick faz fetch+rebase de novo |
| `git push` falha por rede | log warn; commits ficam locais; próximo tick |
| `git push` falha por auth | log **error** + status `auth_failed`; alerta operacional (queue cresce) |
| Commit falha (arquivo removido no FS entre enqueue e tick) | log warn + skip aquele job, segue drenando os outros |
| Worker tick demora >30s | reentrancy guard impede tick novo concorrente; próximo tick após o atual concluir |

#### 2.3.5 Shutdown gracioso

```
process.on('SIGTERM' | 'SIGINT', async () => {
  log({ level: 'info', message: 'Shutting down sync-worker' });
  await syncWorker.stop();   // drena fila + push final, com timeout de 10s
  process.exit(0);
});
```

`syncWorker.stop()`:
1. `clearInterval(this.timer)`
2. Aguarda tick em curso terminar (até 10s)
3. Drena queue: commit + push final
4. Log final com status

Se timeout: log warn + força exit. Os commits ficam locais; safety-net diário recupera.

## 3. Mudanças de container e auth

### 3.1 Deploy key SSH

1. Gerar `ed25519` no host:
   ```sh
   ssh-keygen -t ed25519 -C "mcp-obsidian-deploy@vmi1988871" -f /root/.ssh/fama-brain-deploy -N ""
   ```
2. Registrar pública (`fama-brain-deploy.pub`) como Deploy Key no repo `fama-brain` no GitHub, **com write access**.
3. Mount no `docker-compose.yml`:
   ```yaml
   volumes:
     - /root/fama-brain:/vault:rw
     - /root/.ssh/fama-brain-deploy:/root/.ssh/id_ed25519:ro
     - /root/.ssh/fama-brain-deploy.pub:/root/.ssh/id_ed25519.pub:ro
     - /root/mcp-fama/mcp-obsidian/.env:/app/.env:ro
     - /var/log/mcp-obsidian:/app/logs
   ```
4. `Dockerfile`: adicionar `RUN apk add --no-cache openssh-client` na imagem runtime.
5. Entrypoint (ou diretamente no `index.ts` no boot):
   ```sh
   git config --global user.name "${GIT_AUTHOR_NAME:-mcp-obsidian}"
   git config --global user.email "${GIT_AUTHOR_EMAIL:-mcp@fama.local}"
   git config --global --add safe.directory /vault
   mkdir -p /root/.ssh
   ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null
   chmod 600 /root/.ssh/id_ed25519
   ```
6. Verificação no boot: `git -C /vault remote get-url origin` → deve ser `git@github.com:renatinhosfaria/fama-brain.git` (não HTTPS). Se for HTTPS, trocar uma vez via `git remote set-url`.

### 3.2 Variáveis de ambiente novas

```
SYNC_INTERVAL_MS=30000          # default
SYNC_ENABLED=true               # kill-switch operacional; false = desliga worker, escritas seguem só no FS
GIT_REMOTE=origin
GIT_BRANCH=main
```

Adicionar a `.env.example` e ler em `src/config.ts`.

### 3.3 Cron safety-net (host)

Manter `brain-sync.sh` rodando **1x/dia às 04:00** (em vez de a cada 5min):

```cron
0 4 * * * /root/fama-brain/_infra/brain-sync.sh >> /var/log/brain-sync.log 2>&1
```

Função: capturar edições do Renato se o MCP estiver fora (deploy, manutenção, crash sustentado). Não interfere no fluxo normal.

## 4. Observabilidade

### 4.1 Endpoint `/health` estendido

Resposta atual:
```json
{ "status": "healthy", "vault_notes": 234, "index_age_ms": 12345,
  "git_head": "abc123", "last_write_ts": "..." }
```

Acrescentar:
```json
{
  ...,
  "sync_worker": {
    "enabled": true,
    "queue_size": 0,
    "last_tick_at": "2026-04-26T22:30:00Z",
    "last_tick_outcome": "ok",
    "last_error": null,
    "total_ticks": 1234,
    "total_commits_pushed": 567,
    "total_conflicts_resolved": 2,
    "last_conflict": { "at": "2026-04-25T...", "files": [...], "remote_sha_overridden": "..." }
  }
}
```

### 4.2 Log estruturado

Novos níveis no JSON-line `logs/audit.log`:

```json
{ "level": "info", "component": "sync-worker", "event": "tick_start", "timestamp": "..." }
{ "level": "info", "component": "sync-worker", "event": "fetched", "remote_ahead": 2, "files": [...] }
{ "level": "info", "component": "sync-worker", "event": "pulled_clean", "files_refreshed": [...] }
{ "level": "warn", "component": "sync-worker", "event": "conflict_resolved", "files": [...], "remote_sha": "...", "mcp_paths_kept": [...] }
{ "level": "info", "component": "sync-worker", "event": "commit", "path": "...", "sha": "...", "message": "..." }
{ "level": "info", "component": "sync-worker", "event": "pushed", "commits_pushed": 3 }
{ "level": "warn", "component": "sync-worker", "event": "push_failed", "reason": "non-fast-forward" }
{ "level": "error", "component": "sync-worker", "event": "push_failed", "reason": "auth", "detail": "..." }
```

Conflitos sempre são `warn` (não `error`) — política deliberada, não quebra o sistema.

## 5. Estratégia de testes

### 5.1 Unit (vitest, mock git)

`test/unit/commit-queue.test.ts`:
- enqueue/shift FIFO
- pendingPaths retorna set distinto
- drain retorna todos e esvazia
- size correto

`test/unit/sync-worker.test.ts` (com `GitOps` e `VaultIndex` mocados):
- tick sem overlap → pull + drain + push
- tick com overlap → snapshot + reset + restore + push
- push fail non-fast-forward → próximo tick refaz
- fetch fail → tick segue, queue intacta
- shutdown drena e para

### 5.2 Integration (vault temporário com 2 remotes locais)

`test/integration/sync-worker.test.ts`:

Setup:
```
tmp/
  vault-mcp/  (clone do "remote bare")
  vault-renato/ (clone separado pra simular Renato)
  remote.git/ (bare repo simulando GitHub)
```

Cenários:
1. **Caminho feliz**: MCP escreve, worker tica, push acontece, segundo clone (`vault-renato`) faz pull e vê o commit semântico.
2. **Renato edita primeiro**: `vault-renato` edita arquivo X e pusha. Worker do MCP tica → pull --rebase --autostash, index refrescado.
3. **Conflito real**: ambos editam `_shared/context/fama/visao.md`. Worker resolve com MCP wins, Renato vê commit do MCP por cima do dele no `vault-renato` após pull.
4. **Push falha**: simular remote dropping conexão, verificar que commits ficam locais e segundo tick retoma.
5. **Shutdown durante tick**: SIGTERM ↦ drena fila e termina; verificar que nada ficou pendente.

### 5.3 E2E (smoke existente, atualizar)

`test/e2e/smoke.test.ts`:
- atualizar `expect(tools.length).toBe(35)` (atualmente 34, pendente do commit `e667171` que removeu commit_and_push e adicionou bootstrap_agent + delete_path)
- adicionar verificação `/health` retorna `sync_worker.queue_size === 0` após delay

### 5.4 Coverage thresholds

Manter atuais (`src/vault/**` ≥ 80%). Adicionar `src/vault/sync-worker.ts` ao threshold de 80%.

## 6. Decisões e trade-offs

### 6.1 Por que CommitQueue em memória, sem persistência

**Risco mitigado:** crash do processo MCP entre `enqueue` e push.

**Por que aceitável:**
1. O write atomic já está no FS (`/vault/<path>` tem o conteúdo certo).
2. `git status` mostraria os arquivos como modificados/untracked.
3. O safety-net `brain-sync.sh` 1x/dia faria `git add -A` + commit + push, recuperando o estado.
4. Histórico semântico se perde nesse cenário (commit "auto: sync" cobre vários writes), mas é raro (só em crash).
5. Persistência em disco custaria ~80 linhas + write atômico do queue + recovery no boot — assimetria desfavorável.

**Alternativa rejeitada:** persistir em `/tmp/queue.json` ou em `_infra/.mcp-queue.jsonl`. Reabrir se identificarmos crashes recorrentes em produção.

### 6.2 Por que SSH deploy key, não PAT

- PAT padrão do GitHub expira em 90 dias por default. Deploy key não expira.
- PAT em URL de remote (`https://<token>@github.com/...`) vaza no `git remote -v`, em logs do simple-git, e em qualquer error report.
- Deploy key é granular: write access ao único repo necessário, vs PAT que tem escopo de usuário.
- Operacional: hoje o cron do host já usa SSH; reusar a postura.

**Alternativa aceitável:** PAT em env var `GIT_TOKEN` com escopo `repo`, injetado em runtime via `core.askPass`. Trade: mais simples de provisionar mas operacionalmente pior. Rejeitado.

### 6.3 Por que MCP wins em conflito (não Renato wins)

Política simétrica analisada e descartada:

- **Renato wins:** agente do MCP perderia escritas silenciosamente; índice ficaria fora-de-sync com o que o agente acredita ter escrito; quebra do contrato "tool retornou OK = persistido".
- **MCP wins:** Renato pode "perder" linha digitada, mas detectável via `git log` e o `remote_sha_overridden` no log estruturado permite recuperação. Renato é humano com ferramental; agente é programa com contrato.

A condição é sintoma de antipatrón: editar o mesmo arquivo manualmente e via MCP simultaneamente. Já é uma "Pattern That Doesn't Work" no `.claude/napkin.md`. Política reforça.

### 6.4 Por que 30s e não menor

- 10s testado mentalmente: 360 fetches/hora vs ~120/hora a 30s. GitHub API SSH não tem rate limit explícito mas pula no radar de abuse detection com pulls vazios constantes.
- 60s testado mentalmente: dobra a janela de propagação sem ganho operacional. Renato disse "30s OK".
- Configurável via `SYNC_INTERVAL_MS` permite ajuste sem deploy.

### 6.5 Por que não eliminar `brain-sync.sh` totalmente

- **Disaster recovery:** se MCP container morrer e ficar inativo por dias (deploy falho, infra issue), o vault no VPS não diverge irreversivelmente do GitHub. Cron diário garante "pull-only" continua funcionando.
- Custo trivial: 1 linha no crontab, script já existe.
- Modificação: alterar de `*/5 * * * *` para `0 4 * * *` (1x/dia, 04:00 UTC).
- Função futura: pode adicionar comando `git status -s | wc -l` e alertar via webhook se houver mais de N arquivos modificados sem commit (sintoma de worker travado).

## 7. Plano de migração

Faseado pra evitar gap de sync:

### Fase 0 — Pré-requisitos (15min)
1. Gerar deploy key SSH no host.
2. Registrar como Deploy Key no GitHub `fama-brain` com write access.
3. Verificar `git -C /root/fama-brain remote get-url origin` → trocar para SSH se HTTPS.
4. Confirmar conectividade: `ssh -T git@github.com` no host.

### Fase 1 — Implementação (~1-2 dias)
1. Branch `feat/sync-worker` no `mcp-fama/mcp-obsidian`.
2. Implementar `CommitQueue`, `SyncWorker`, `GitOps` extensions, `VaultIndex.refreshPaths`.
3. Wire-up no `server.ts` + handlers de SIGTERM/SIGINT em `index.ts`.
4. Modificar tools de write para enqueue.
5. Atualizar `Dockerfile` + `docker-compose.yml`.
6. Atualizar `.env.example`.
7. Tests unit + integration.
8. Smoke test com `tools.length === 35`.

### Fase 2 — Deploy paralelo (1 dia)
1. Deploy do MCP novo com `SYNC_ENABLED=false` — worker desligado, comportamento idêntico ao atual.
2. Cron `brain-sync.sh` segue rodando a cada 5min.
3. Validar que MCP não regrediu em throughput / latência via `/health`.

### Fase 3 — Cutover (~1h)
1. Trocar cron host de `*/5 * * * *` para `0 4 * * *` (1x/dia).
2. Setar `SYNC_ENABLED=true` via `.env` + `docker compose up -d`.
3. Monitorar primeiras horas:
   - `/health` → `sync_worker.last_tick_outcome === 'ok'`
   - GitHub histórico → ver commits semânticos chegando.
   - Editar manualmente algo no Obsidian → ver se MCP percebe em ≤60s.

### Fase 4 — Validação (1 semana)
1. Provocar conflito artificial: editar mesmo arquivo no Obsidian e via MCP.
2. Confirmar log estruturado registra com `remote_sha_overridden`.
3. Confirmar Renato consegue recuperar via `git show <sha>`.
4. Atualizar `.claude/napkin.md` com observações.

### Rollback
- Setar `SYNC_ENABLED=false`, restaurar cron `*/5 * * * *`. Dois passos, 2 minutos. Vault não corrompe — pior caso é perda do histórico semântico no período.

## 8. Itens fora desta spec (futuro)

- Resource MCP `obsidian://sync` expondo status do worker (decisão posterior).
- Webhook/alerta em `event: 'auth_failed'` ou queue size sustentado >100 (depende de stack de alerta).
- Fila persistente em disco (apenas se observarmos crashes recorrentes em prod).
- Suporte multi-réplica (não previsto; vault tem 1 escritor automatizado por design).
- Substituir `git push` por `git push --force-with-lease` em algum cenário (rejeitado: política MCP wins não exige force; reset+restore faz fast-forward natural).
- Métricas Prometheus (depende de stack atual).

## 9. Resumo executivo

| Antes | Depois |
|---|---|
| Cron host 5min, commits "auto: sync" | Worker in-process 30s, commits semânticos por operação |
| Janela MCP→Renato: 5min | ~30s |
| Janela Renato→MCP+index: 5min + ∞ até write | ~30s |
| Conflito real silencioso via `--autostash` | Política determinística "MCP wins por arquivo" + log auditável |
| 4 pontos de complexidade (cron, flock, brain-sync.sh, autostash hidden) | 1 worker + safety-net 1x/dia |
| Auth git no host | Auth git no container (deploy key) |
| ~3ms latência de write tool | ~3ms (sem regressão) |

Implementação contida (~250-350 linhas novas + ~60 modificadas + testes). Reutiliza `simple-git` já presente. Risco de regressão baixo dada a estratégia de cutover faseada com kill-switch (`SYNC_ENABLED`).
