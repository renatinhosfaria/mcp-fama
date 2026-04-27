# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- Comunicar em português (pt-BR) quando o usuário solicitar.

## Patterns That Work
- Validar mudanças em `_shared/context/AGENTS.md` rodando `parseOwnershipMap` + `resolveOwner` via `npx tsx -e` contra uma lista de caminhos-alvo (mix de casos positivos e negativos como `MEMORY.md => null`). Detecta erros de glob e ordem antes de qualquer commit.

## Patterns That Don't Work
- Editar múltiplos arquivos relacionados no vault `/root/fama-brain` em janelas separadas de tempo: o cron `brain-sync.sh` roda a cada 5 min e pode commitar um subset das mudanças antes das outras chegarem, criando 2 commits onde semanticamente seria 1. Não é problema (nada se perde), mas fragmenta o histórico git. Se mudanças precisam ser atômicas, escrever todas num mesmo burst antes do próximo múltiplo de 5 min do relógio, ou commitar manualmente antes do cron.

## Domain Notes
- Agente Paperclip "Vault" (id `7be1b6c7-51ba-4f1a-b57a-9cd7bed4667b`, adapter `claude_local`). Processo PID 1 do container Paperclip roda como **UID 1000 (user `www`), não root** — `/root` no container é `0700 root:root`, logo UID 1000 não consegue traversar nada sob `/root`. Caminho correto pra expor repos ao agente: bind-mount com `target=/opt/...` (não `/root/...`) E `chown -R 1000:1000` no dir do host. `adapter_config.cwd` do agent precisa bater com o target. Fix atual do Vault: bind `/root/mcp-fama/mcp-obsidian → /opt/fama/mcp-obsidian`, host chown `www:www` (1000), `cwd=/opt/fama/mcp-obsidian/`. Erro típico se errar: `EACCES: permission denied, stat '<cwd>'` em `assertDirectory` (`/app/packages/adapter-utils/src/server-utils.ts:663`).
- Projeto: servidor MCP para Obsidian (mcp-fama/mcp-obsidian), branch principal `main`.
- Spec aparentemente completa até 34 tools, incluindo broker executive views (§5.6).
- Vault fama-brain fica em `/root/fama-brain` (NÃO `/toor/fama/brain` — usuário errou o path uma vez).
- `frontmatter.ts` aceita 15 tipos (11 originais + `project-readme`, `shared-context`, `entity-profile`, `financial-snapshot`). Manter em sync com `fama-brain/CLAUDE.md` e `fama-brain/README.md` — a doc do vault drifta fácil quando novos Plans adicionam tipos.
- Ownership é resolvido por `minimatch` com primeira-regra-vence. Renato é "dono" de raiz (README, CLAUDE, `_projects/**`, `_infra/**`, `_shared/context/fama/**`, `_shared/context/FAMA.md`, `_shared/context/AGENTS.md`, `_agents/README.md`) mas não é "agente" no sentido das tools agent-scoped — não tem pasta em `_agents/`.
- Tópicos canônicos §5.8 são 6: `opt-out, objecoes, retomadas, aprendizados, abordagens, regressoes`. Só `opt-out/` e `regressoes/` têm pasta pré-criada no vault; os outros 4 nascem na primeira escrita.
