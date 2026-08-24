# MCP Repository Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separar os tres servidores do monorepo `mcp-fama` em repositorios publicos independentes, preservar seus historicos, remover material sensivel e arquivar o repositorio original sanitizado.

**Architecture:** A migracao usa clones descartaveis e `git-filter-repo` para extrair cada prefixo para a raiz de um novo repositorio. Os novos historicos passam por integridade, testes e varredura redigida de segredos antes dos pushes; o original e reescrito em um clone espelho e arquivado somente no ultimo gate.

**Tech Stack:** Git 2.34+, git-filter-repo 2.47.0 via `uvx`, GitHub CLI, Gitleaks 8.30.1 via Docker, Node.js 22, npm 10, TypeScript.

**Spec:** `docs/plans/2026-08-24-mcp-repository-split-design.md`

## Global Constraints

- A origem e `/root/mcp-fama`; nenhum arquivo local ignorado pode ser publicado ou apagado.
- O diretorio de Meta Ads e `meta-ads-mcp-server/`; nao criar `mcp-ads-mcp-server/`.
- Diretorios locais e nomes dos pacotes Node.js permanecem inalterados.
- Destinos: `renatinhosfaria/mcp-minio`, `renatinhosfaria/mcp-famachat` e `renatinhosfaria/mcp-meta-ads`.
- Os destinos recebem somente `main`; as branches auxiliares do original ja estao incorporadas.
- `.env` nunca pode existir nos novos historicos; `node_modules/` e `dist/` nunca podem existir no historico de `mcp-meta-ads`.
- A mudanca local em `mcp-postgres/src/index.ts` vira um commit proprio em `mcp-famachat` e permanece intacta no workspace original.
- Nenhum push dos destinos usa force; a reescrita do original usa leases com hashes verificados.
- O bundle antigo permanece local com permissao `0600`, pois contem objetos sensiveis.
- Mudanca concorrente remota ou achado do Gitleaks interrompe a migracao antes do proximo write externo.
- `mcp-fama` so pode ser arquivado depois dos testes e clones pos-push passarem.

---

### Task 1: Congelar o estado e criar backup recuperavel

**Files:**
- Create: `/root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle`
- Create: `/root/mcp-fama-migration-20260824/famachat-local.patch`
- Verify: `/root/mcp-fama/mcp-postgres/src/index.ts`

**Interfaces:**
- Consumes: repositorio de origem e remotos aprovados.
- Produces: bundle verificado, patch relativo a raiz do futuro FamaChat e workspace restrito.

- [ ] **Step 1: Confirmar autenticacao e estado dos quatro repositorios**

```bash
cd /root/mcp-fama
gh auth status
gh repo view renatinhosfaria/mcp-fama --json viewerPermission,isArchived,isPrivate
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  gh repo view "renatinhosfaria/$repo" --json url,isArchived,isPrivate,defaultBranchRef
  test -z "$(git ls-remote "https://github.com/renatinhosfaria/$repo.git")"
done
```

Expected: permissao `ADMIN`, origem publica e ativa, tres destinos publicos, ativos e sem referencias.

- [ ] **Step 2: Confirmar que a unica mudanca de trabalho e a conhecida**

```bash
cd /root/mcp-fama
test "$(git status --porcelain=v1 --untracked-files=no)" = " M mcp-postgres/src/index.ts"
git diff --check -- mcp-postgres/src/index.ts
git diff --stat -- mcp-postgres/src/index.ts
```

Expected: uma insercao e uma remocao, sem erro de whitespace. Nao imprimir o diff completo.

- [ ] **Step 3: Criar o bundle com todas as referencias locais**

```bash
test ! -e /root/mcp-fama-migration-20260824
install -d -m 700 /root/mcp-fama-migration-20260824
git -C /root/mcp-fama bundle create /root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle --all
chmod 600 /root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle
git -C /root/mcp-fama bundle verify /root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle
```

Expected: bundle verificado e modo `0600`.

- [ ] **Step 4: Exportar a mudanca FamaChat com caminhos relativos**

```bash
git -C /root/mcp-fama diff --binary --relative=mcp-postgres \
  --output=/root/mcp-fama-migration-20260824/famachat-local.patch \
  -- mcp-postgres/src/index.ts
chmod 600 /root/mcp-fama-migration-20260824/famachat-local.patch
test -s /root/mcp-fama-migration-20260824/famachat-local.patch
rg -q '^diff --git a/src/index\.ts b/src/index\.ts$' /root/mcp-fama-migration-20260824/famachat-local.patch
! rg -q '^diff --git .*\.env' /root/mcp-fama-migration-20260824/famachat-local.patch
```

Expected: patch nao vazio, somente de `src/index.ts`, sem caminho de ambiente.

- [ ] **Step 5: Congelar os hashes remotos esperados**

```bash
git ls-remote --heads --tags https://github.com/renatinhosfaria/mcp-fama.git
```

Expected:

```text
21d7ea099858a1703c978022e87fc10f24ca612a refs/heads/agent/increase-meta-mcp-payload-limit
e32afda5379cbc3f6e1e19d9e29a2fb698530b77 refs/heads/agent/remove-meta-audience-is-raw
c8f144f1e31243e990a656de320f11217fb7de4e refs/heads/codex/inactivate-obsidian
2664678eb7b6fb4023f373647bd40662810d0097 refs/heads/main
```

Qualquer diferenca interrompe a execucao para nova auditoria.

---

### Task 2: Extrair e validar `mcp-minio`

**Files:**
- Create: `/root/mcp-fama-migration-20260824/mcp-minio/`
- Preserve: `/root/mcp-fama/mcp-minio/`

**Interfaces:**
- Consumes: `main` local de `/root/mcp-fama`.
- Produces: repositorio filtrado com tres commits e remoto `mcp-minio`.

- [ ] **Step 1: Clonar e filtrar o prefixo**

```bash
git clone --no-hardlinks --single-branch --branch main /root/mcp-fama /root/mcp-fama-migration-20260824/mcp-minio
cd /root/mcp-fama-migration-20260824/mcp-minio
uvx --from git-filter-repo==2.47.0 git-filter-repo --path mcp-minio/ --path-rename mcp-minio/: --force
git remote add origin https://github.com/renatinhosfaria/mcp-minio.git
```

Expected: conteudo MinIO na raiz e nenhum outro servidor.

- [ ] **Step 2: Verificar historia, arvore e integridade**

```bash
cd /root/mcp-fama-migration-20260824/mcp-minio
test "$(git rev-list --count main)" -eq 3
test -f package.json
test -f src/index.ts
test -f .gitignore
test -z "$(git ls-files | rg '^(mcp-minio|mcp-postgres|meta-ads-mcp-server)/' || true)"
test -z "$(git ls-files | rg '(^|/)\.env($|\.)' | rg -v '\.env\.example$' || true)"
git fsck --full
git fsck --no-reflogs --unreachable
```

Expected: tres commits, raiz limpa e nenhum objeto quebrado ou inacessivel.

- [ ] **Step 3: Instalar dependencias e testar**

```bash
cd /root/mcp-fama-migration-20260824/mcp-minio
npm ci
npm run typecheck
npm run build
test -z "$(git status --short)"
```

Expected: exit `0` em todos os comandos e working tree limpa.

---

### Task 3: Extrair `mcp-famachat` e incorporar a mudanca local

**Files:**
- Create: `/root/mcp-fama-migration-20260824/mcp-famachat/`
- Modify: `/root/mcp-fama-migration-20260824/mcp-famachat/src/index.ts`
- Test: `/root/mcp-fama-migration-20260824/mcp-famachat/tests/**/*.test.ts`

**Interfaces:**
- Consumes: patch da Task 1 e `main` local.
- Produces: nove commits historicos e um commit para limite de payload.

- [ ] **Step 1: Clonar e filtrar o prefixo**

```bash
git clone --no-hardlinks --single-branch --branch main /root/mcp-fama /root/mcp-fama-migration-20260824/mcp-famachat
cd /root/mcp-fama-migration-20260824/mcp-famachat
uvx --from git-filter-repo==2.47.0 git-filter-repo --path mcp-postgres/ --path-rename mcp-postgres/: --force
git remote add origin https://github.com/renatinhosfaria/mcp-famachat.git
test "$(git rev-list --count main)" -eq 9
```

Expected: nove commits e conteudo de `mcp-postgres/` na raiz.

- [ ] **Step 2: Validar e aplicar exclusivamente o patch aprovado**

```bash
cd /root/mcp-fama-migration-20260824/mcp-famachat
git apply --check /root/mcp-fama-migration-20260824/famachat-local.patch
git apply /root/mcp-fama-migration-20260824/famachat-local.patch
test "$(git diff --name-only)" = "src/index.ts"
git diff --check
git diff --stat
```

Expected: somente `src/index.ts`, com uma insercao e uma remocao.

- [ ] **Step 3: Testar antes de registrar a mudanca**

```bash
cd /root/mcp-fama-migration-20260824/mcp-famachat
npm ci
npm test
npm run typecheck
npm run build
```

Expected: testes, typecheck e build com exit `0`.

- [ ] **Step 4: Criar o commit dedicado e verificar integridade**

```bash
cd /root/mcp-fama-migration-20260824/mcp-famachat
git add src/index.ts
git commit -m "fix: limit FamaChat request body size"
test "$(git rev-list --count main)" -eq 10
test -z "$(git status --short)"
test -z "$(git ls-files | rg '^(mcp-minio|mcp-postgres|meta-ads-mcp-server)/' || true)"
test -z "$(git ls-files | rg '(^|/)\.env($|\.)' | rg -v '\.env\.example$' || true)"
git fsck --full
git fsck --no-reflogs --unreachable
```

Expected: dez commits, working tree limpa e integridade valida.

---

### Task 4: Extrair e higienizar `mcp-meta-ads`

**Files:**
- Create: `/root/mcp-fama-migration-20260824/mcp-meta-ads/`
- Create: `/root/mcp-fama-migration-20260824/mcp-meta-ads/.gitignore`
- Remove from all commits: `.env`, `node_modules/`, `dist/`

**Interfaces:**
- Consumes: `main` local, incluindo `f9fea6e`.
- Produces: dezenove commits historicos higienizados e um commit de exclusoes permanentes.

- [ ] **Step 1: Clonar, filtrar o prefixo e remover artefatos do historico**

```bash
git clone --no-hardlinks --single-branch --branch main /root/mcp-fama /root/mcp-fama-migration-20260824/mcp-meta-ads
cd /root/mcp-fama-migration-20260824/mcp-meta-ads
uvx --from git-filter-repo==2.47.0 git-filter-repo --path meta-ads-mcp-server/ --path-rename meta-ads-mcp-server/: --force
uvx --from git-filter-repo==2.47.0 git-filter-repo \
  --path .env --path node_modules/ --path dist/ --invert-paths --force
git remote add origin https://github.com/renatinhosfaria/mcp-meta-ads.git
```

Expected: codigo Meta Ads na raiz, sem `.env`, `node_modules/` ou `dist/` nos commits.

- [ ] **Step 2: Criar regras permanentes de exclusao**

Use `apply_patch` to create `/root/mcp-fama-migration-20260824/mcp-meta-ads/.gitignore` with exactly:

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
*.log
```

Run:

```bash
cd /root/mcp-fama-migration-20260824/mcp-meta-ads
git add .gitignore
git commit -m "chore: ignore generated and local environment files"
```

Expected: um unico commit novo contendo somente `.gitignore`.

- [ ] **Step 3: Provar remocao historica e integridade**

```bash
cd /root/mcp-fama-migration-20260824/mcp-meta-ads
test "$(git rev-list --count main)" -eq 20
test -z "$(git log --all --format= --name-only -- .env node_modules dist | sed '/^$/d')"
test -z "$(git ls-files | rg '(^|/)(\.env|node_modules/|dist/)' | rg -v '^\.env\.example$' || true)"
test -f .env.example
git fsck --full
git fsck --no-reflogs --unreachable
```

Expected: vinte commits, nenhum caminho proibido e integridade valida.

- [ ] **Step 4: Provar que `dist/` e regeneravel e ignorado**

```bash
cd /root/mcp-fama-migration-20260824/mcp-meta-ads
npm ci
npm run build
test -d dist
test -z "$(git status --short)"
```

Expected: build com exit `0`, `dist/` criado e working tree limpa.

---

### Task 5: Comparar historicos e varrer segredos

**Files:**
- Create: `/root/mcp-fama-migration-20260824/*.source-history`
- Create: `/root/mcp-fama-migration-20260824/*.target-history`
- Create inside Git metadata: redacted Gitleaks reports.

**Interfaces:**
- Consumes: tres repositorios filtrados.
- Produces: comparacoes exatas de metadados e scans com exit `0`.

- [ ] **Step 1: Comparar a sequencia de commits do MinIO**

```bash
git -C /root/mcp-fama log --reverse --format='%aI%x09%an%x09%s' \
  --output=/root/mcp-fama-migration-20260824/minio.source-history -- mcp-minio
git -C /root/mcp-fama-migration-20260824/mcp-minio log --reverse --format='%aI%x09%an%x09%s' \
  --output=/root/mcp-fama-migration-20260824/minio.target-history main
diff -u /root/mcp-fama-migration-20260824/minio.source-history \
  /root/mcp-fama-migration-20260824/minio.target-history
```

Expected: nenhuma diferenca.

- [ ] **Step 2: Comparar os nove commits historicos do FamaChat**

```bash
git -C /root/mcp-fama log --reverse --format='%aI%x09%an%x09%s' \
  --output=/root/mcp-fama-migration-20260824/famachat.source-history -- mcp-postgres
git -C /root/mcp-fama-migration-20260824/mcp-famachat log --reverse --format='%aI%x09%an%x09%s' \
  --output=/root/mcp-fama-migration-20260824/famachat.target-history main~1
diff -u /root/mcp-fama-migration-20260824/famachat.source-history \
  /root/mcp-fama-migration-20260824/famachat.target-history
```

Expected: nenhuma diferenca; o decimo commit e o patch local aprovado.

- [ ] **Step 3: Comparar os dezenove commits historicos do Meta Ads**

```bash
git -C /root/mcp-fama log --reverse --format='%aI%x09%an%x09%s' \
  --output=/root/mcp-fama-migration-20260824/meta.source-history -- meta-ads-mcp-server
git -C /root/mcp-fama-migration-20260824/mcp-meta-ads log --reverse --format='%aI%x09%an%x09%s' \
  --output=/root/mcp-fama-migration-20260824/meta.target-history main~1
diff -u /root/mcp-fama-migration-20260824/meta.source-history \
  /root/mcp-fama-migration-20260824/meta.target-history
```

Expected: nenhuma diferenca; o vigesimo commit e o `.gitignore`.

- [ ] **Step 4: Executar Gitleaks fixado e com redacao nos tres destinos**

```bash
docker pull ghcr.io/gitleaks/gitleaks:v8.30.1
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  docker run --rm \
    -v "/root/mcp-fama-migration-20260824/$repo:/repo" \
    ghcr.io/gitleaks/gitleaks:v8.30.1 \
    git --redact --report-format json \
    --report-path /repo/.git/gitleaks-report.json \
    --log-opts=--all /repo
done
```

Expected: tres exits `0`. Se algum scan falhar, parar, inspecionar apenas o relatorio redigido e nao fazer push.

---

### Task 6: Publicar e verificar os tres destinos

**Files:**
- Create: `/root/mcp-fama-migration-20260824/verify-mcp-minio/`
- Create: `/root/mcp-fama-migration-20260824/verify-mcp-famachat/`
- Create: `/root/mcp-fama-migration-20260824/verify-mcp-meta-ads/`

**Interfaces:**
- Consumes: repositorios filtrados, testados e escaneados.
- Produces: tres repositorios GitHub com `main` e clones pos-push verificados.

- [ ] **Step 1: Reconfirmar destinos vazios imediatamente antes do write externo**

```bash
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  test -z "$(git ls-remote "https://github.com/renatinhosfaria/$repo.git")"
done
```

Expected: zero referencias; qualquer referencia nova interrompe a tarefa.

- [ ] **Step 2: Publicar somente `main`, sem force**

```bash
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  git -C "/root/mcp-fama-migration-20260824/$repo" push --set-upstream origin main
done
```

Expected: tres pushes iniciais bem-sucedidos.

- [ ] **Step 3: Confirmar referencias e branch padrao**

```bash
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  test "$(git ls-remote --heads "https://github.com/renatinhosfaria/$repo.git" | wc -l)" -eq 1
  git ls-remote --exit-code "https://github.com/renatinhosfaria/$repo.git" refs/heads/main
  gh repo view "renatinhosfaria/$repo" --json defaultBranchRef,isArchived,isPrivate
done
```

Expected: uma unica branch `main`, repositorios publicos e ativos.

- [ ] **Step 4: Clonar do GitHub e repetir testes limpos**

```bash
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  git clone --single-branch --branch main \
    "https://github.com/renatinhosfaria/$repo.git" \
    "/root/mcp-fama-migration-20260824/verify-$repo"
  git -C "/root/mcp-fama-migration-20260824/verify-$repo" fsck --full
done
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-minio ci
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-minio run typecheck
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-minio run build
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-famachat ci
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-famachat test
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-famachat run typecheck
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-famachat run build
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-meta-ads ci
npm --prefix /root/mcp-fama-migration-20260824/verify-mcp-meta-ads run build
```

Expected: todos os comandos com exit `0`.

---

### Task 7: Tornar os diretorios locais repositorios independentes

**Files:**
- Create: `/root/mcp-fama/mcp-minio/.git/`
- Create: `/root/mcp-fama/mcp-postgres/.git/`
- Create: `/root/mcp-fama/meta-ads-mcp-server/.git/`
- Create: `/root/mcp-fama/meta-ads-mcp-server/.gitignore`

**Interfaces:**
- Consumes: tres remotos publicados e validados.
- Produces: repositorios aninhados nos caminhos atuais, sem apagar arquivos locais ignorados.

- [ ] **Step 1: Provar ausencia de metadados Git aninhados**

```bash
test ! -e /root/mcp-fama/mcp-minio/.git
test ! -e /root/mcp-fama/mcp-postgres/.git
test ! -e /root/mcp-fama/meta-ads-mcp-server/.git
```

Expected: os tres testes passam.

- [ ] **Step 2: Inicializar MinIO e FamaChat sem substituir working trees**

```bash
git -C /root/mcp-fama/mcp-minio init --initial-branch=main
git -C /root/mcp-fama/mcp-minio remote add origin https://github.com/renatinhosfaria/mcp-minio.git
git -C /root/mcp-fama/mcp-minio fetch origin main
git -C /root/mcp-fama/mcp-minio reset --mixed origin/main
git -C /root/mcp-fama/mcp-minio branch --set-upstream-to=origin/main main

git -C /root/mcp-fama/mcp-postgres init --initial-branch=main
git -C /root/mcp-fama/mcp-postgres remote add origin https://github.com/renatinhosfaria/mcp-famachat.git
git -C /root/mcp-fama/mcp-postgres fetch origin main
git -C /root/mcp-fama/mcp-postgres reset --mixed origin/main
git -C /root/mcp-fama/mcp-postgres branch --set-upstream-to=origin/main main
```

Expected: ambos apontam para seus remotos e ficam limpos; a mudanca FamaChat coincide com o commit publicado.

- [ ] **Step 3: Inicializar Meta Ads e materializar somente o `.gitignore` novo**

```bash
git -C /root/mcp-fama/meta-ads-mcp-server init --initial-branch=main
git -C /root/mcp-fama/meta-ads-mcp-server remote add origin https://github.com/renatinhosfaria/mcp-meta-ads.git
git -C /root/mcp-fama/meta-ads-mcp-server fetch origin main
git -C /root/mcp-fama/meta-ads-mcp-server reset --mixed origin/main
git -C /root/mcp-fama/meta-ads-mcp-server restore .gitignore
git -C /root/mcp-fama/meta-ads-mcp-server branch --set-upstream-to=origin/main main
```

Expected: `.env`, `node_modules/` e `dist/` locais permanecem no disco, ignorados e nao rastreados.

- [ ] **Step 4: Verificar isolamento, remotos e limpeza**

```bash
test "$(git -C /root/mcp-fama/mcp-minio rev-parse --show-toplevel)" = /root/mcp-fama/mcp-minio
test "$(git -C /root/mcp-fama/mcp-postgres rev-parse --show-toplevel)" = /root/mcp-fama/mcp-postgres
test "$(git -C /root/mcp-fama/meta-ads-mcp-server rev-parse --show-toplevel)" = /root/mcp-fama/meta-ads-mcp-server
test -z "$(git -C /root/mcp-fama/mcp-minio status --short)"
test -z "$(git -C /root/mcp-fama/mcp-postgres status --short)"
test -z "$(git -C /root/mcp-fama/meta-ads-mcp-server status --short)"
git -C /root/mcp-fama/mcp-minio remote -v
git -C /root/mcp-fama/mcp-postgres remote -v
git -C /root/mcp-fama/meta-ads-mcp-server remote -v
```

Expected: tres toplevels distintos, working trees limpas e URLs corretas.

---

### Task 8: Sanitizar as branches publicadas do original

**Files:**
- Create: `/root/mcp-fama-migration-20260824/mcp-fama-sanitized.git/`
- Create: `/root/mcp-fama-migration-20260824/original-gitleaks.json`
- Rewrite remotely: four branches of `renatinhosfaria/mcp-fama`.

**Interfaces:**
- Consumes: bundle, hashes congelados e `main` local com commits nao publicados.
- Produces: origem publica sem `meta-ads-mcp-server/.env` em nenhuma branch.

- [ ] **Step 1: Espelhar referencias publicadas e avancar `main` para a local**

```bash
git clone --mirror https://github.com/renatinhosfaria/mcp-fama.git \
  /root/mcp-fama-migration-20260824/mcp-fama-sanitized.git
git --git-dir=/root/mcp-fama-migration-20260824/mcp-fama-sanitized.git \
  fetch /root/mcp-fama main:refs/heads/main
```

Expected: quatro branches; `main` inclui `f9fea6e`, a especificacao e este plano, sem branches locais nunca publicadas.

- [ ] **Step 2: Remover o `.env` de todas as referencias do espelho**

```bash
cd /root/mcp-fama-migration-20260824/mcp-fama-sanitized.git
uvx --from git-filter-repo==2.47.0 git-filter-repo \
  --path meta-ads-mcp-server/.env --invert-paths --force
test -z "$(git log --all --format= --name-only -- meta-ads-mcp-server/.env | sed '/^$/d')"
git fsck --full
git fsck --no-reflogs --unreachable
```

Expected: caminho ausente de todo o historico e espelho integro.

- [ ] **Step 3: Escanear todo o historico sanitizado**

```bash
docker run --rm \
  -v /root/mcp-fama-migration-20260824:/work \
  ghcr.io/gitleaks/gitleaks:v8.30.1 \
  git --redact --report-format json \
  --report-path /work/original-gitleaks.json \
  --log-opts=--all /work/mcp-fama-sanitized.git
```

Expected: exit `0`. Se falhar, parar antes do force-push e inspecionar apenas o relatorio redigido.

- [ ] **Step 4: Reconfirmar leases e atualizar exatamente quatro branches**

```bash
test "$(git ls-remote https://github.com/renatinhosfaria/mcp-fama.git refs/heads/main | cut -f1)" = 2664678eb7b6fb4023f373647bd40662810d0097
test "$(git ls-remote https://github.com/renatinhosfaria/mcp-fama.git refs/heads/agent/increase-meta-mcp-payload-limit | cut -f1)" = 21d7ea099858a1703c978022e87fc10f24ca612a
test "$(git ls-remote https://github.com/renatinhosfaria/mcp-fama.git refs/heads/agent/remove-meta-audience-is-raw | cut -f1)" = e32afda5379cbc3f6e1e19d9e29a2fb698530b77
test "$(git ls-remote https://github.com/renatinhosfaria/mcp-fama.git refs/heads/codex/inactivate-obsidian | cut -f1)" = c8f144f1e31243e990a656de320f11217fb7de4e

git --git-dir=/root/mcp-fama-migration-20260824/mcp-fama-sanitized.git push \
  https://github.com/renatinhosfaria/mcp-fama.git \
  --force-with-lease=refs/heads/main:2664678eb7b6fb4023f373647bd40662810d0097 \
  --force-with-lease=refs/heads/agent/increase-meta-mcp-payload-limit:21d7ea099858a1703c978022e87fc10f24ca612a \
  --force-with-lease=refs/heads/agent/remove-meta-audience-is-raw:e32afda5379cbc3f6e1e19d9e29a2fb698530b77 \
  --force-with-lease=refs/heads/codex/inactivate-obsidian:c8f144f1e31243e990a656de320f11217fb7de4e \
  refs/heads/main:refs/heads/main \
  refs/heads/agent/increase-meta-mcp-payload-limit:refs/heads/agent/increase-meta-mcp-payload-limit \
  refs/heads/agent/remove-meta-audience-is-raw:refs/heads/agent/remove-meta-audience-is-raw \
  refs/heads/codex/inactivate-obsidian:refs/heads/codex/inactivate-obsidian
```

Expected: quatro atualizacoes aceitas pelos leases, sem branch criada ou removida.

- [ ] **Step 5: Clonar e provar a remocao remota**

```bash
git clone --mirror https://github.com/renatinhosfaria/mcp-fama.git \
  /root/mcp-fama-migration-20260824/verify-mcp-fama-sanitized.git
test -z "$(git --git-dir=/root/mcp-fama-migration-20260824/verify-mcp-fama-sanitized.git \
  log --all --format= --name-only -- meta-ads-mcp-server/.env | sed '/^$/d')"
test "$(git --git-dir=/root/mcp-fama-migration-20260824/verify-mcp-fama-sanitized.git \
  for-each-ref --format='%(refname)' refs/heads | wc -l)" -eq 4
git --git-dir=/root/mcp-fama-migration-20260824/verify-mcp-fama-sanitized.git fsck --full
```

Expected: quatro branches, nenhum `.env` historico e integridade valida.

---

### Task 9: Arquivar o original e concluir a auditoria

**Files:**
- Preserve: `/root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle`
- Verify: three local nested repositories and four GitHub repositories.

**Interfaces:**
- Consumes: todos os gates anteriores aprovados.
- Produces: `mcp-fama` arquivado e relatorio com hashes, testes e rollback.

- [ ] **Step 1: Executar o gate final dos destinos e do backup**

```bash
for repo in mcp-minio mcp-famachat mcp-meta-ads; do
  test "$(git ls-remote --heads "https://github.com/renatinhosfaria/$repo.git" | wc -l)" -eq 1
  gh repo view "renatinhosfaria/$repo" --json defaultBranchRef,isArchived,isPrivate
done
test -z "$(git -C /root/mcp-fama/mcp-minio status --short)"
test -z "$(git -C /root/mcp-fama/mcp-postgres status --short)"
test -z "$(git -C /root/mcp-fama/meta-ads-mcp-server status --short)"
git -C /root/mcp-fama bundle verify /root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle
```

Expected: destinos publicos e ativos, working trees limpas e backup verificavel.

- [ ] **Step 2: Arquivar o original**

```bash
gh repo archive renatinhosfaria/mcp-fama --yes
gh repo view renatinhosfaria/mcp-fama --json url,isArchived,isPrivate,defaultBranchRef
```

Expected: `isArchived` igual a `true` e repositorio ainda publico.

- [ ] **Step 3: Capturar hashes finais e permissao do rollback**

```bash
for repo in mcp-minio mcp-famachat mcp-meta-ads mcp-fama; do
  git ls-remote --symref "https://github.com/renatinhosfaria/$repo.git" HEAD
done
stat -c '%a %n' /root/mcp-fama-migration-20260824/mcp-fama-before-rewrite.bundle
```

Expected: quatro HEADs resolvidos e bundle com modo `600`.

- [ ] **Step 4: Relatar o resultado sem expor segredos**

O relatorio final deve conter exatamente estas categorias:

```text
- URLs e hashes finais dos tres novos repositorios.
- Resultados de build, typecheck, testes, git fsck e Gitleaks.
- Confirmacao dos tres diretorios locais com .git independentes.
- Confirmacao da sanitizacao e do arquivamento de mcp-fama.
- Caminho e permissao do bundle de rollback.
- Lembrete de rotacao da credencial historicamente publicada no sistema emissor.
```

Expected: nenhum valor de segredo e nenhuma alegacao de rotacao nao executada.
