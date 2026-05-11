# MCP Obsidian Schema v1 e Roteamento Reno-First

Data: 2026-05-11
Status: aprovado em brainstorming

## Contexto

O vault FAM definiu o Schema v1 em `_meta/schema.md`, mas o MCP Obsidian ainda conserva rotas e ferramentas legadas que escrevem em `_agents/**`. Esta evolucao transforma o MCP em guardiao do contrato v1: ele deve validar, rotear e auditar escritas novas, preservando compatibilidade apenas na entrada.

O principio central e: nomes antigos podem continuar existindo temporariamente, mas escrita real nova deve sair sempre nos destinos v1.

## Objetivos

- Aceitar e validar frontmatter Schema v1.
- Aceitar datas em `YYYY-MM-DD` e ISO-8601 com timezone.
- Bloquear definitivamente escrita nova em `_agents/**`.
- Implementar roteamento de escrita por tipo para `_entities/`, `_journal/`, `_decisions/`, `_runbooks/`, `_hubs/` e `_meta/`.
- Substituir decisao compilada em `_agents/*/decisions.md` por nota atomica em `_decisions/`.
- Criar tools v1 para Reno-first sem dar permissao ampla de escrita.
- Aplicar trust, ownership, index policy e auditoria continua.

## Contrato de compatibilidade

O contrato novo do MCP e Schema v1. O parser deve continuar tolerante para conseguir ler notas legadas e notas parcialmente migradas, mas as tools v1 devem emitir frontmatter minimo valido:

```yaml
schema_version: 1
type: interaction | decision | entity | hub | journal | concept | reference | runbook | project | goal | result
status: draft | active | superseded | archived
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: human-curated | agent-generated | imported
tags: []
```

Campos desconhecidos de frontmatter devem ser preservados e aceitos, mas os campos obrigatorios nao podem sumir. Exemplos de campos aceitos sem rejeicao: `author_agent`, `verified_by`, `verified_at`, `confidence`, `mentions_entity`, `participants`, `decided_by`, `supersedes`, `superseded_by`, `implements`, `related`, `external_ids`, `aliases`, `relationships`, `source_url`, `source_author`, `source_date`, `valid_until`, `scope`, `maintainer`, `procedure_owner`, `trigger`, `goal` e `status_lifecycle`.

`README.md`, `readme.md` e `index.md` sao filenames validos. Novas notas comuns continuam usando slug em kebab-case.

Qualquer escrita direta em `_agents/**` deve falhar com `LEGACY_NAMESPACE_REMOVED`, antes de ownership. Isso inclui `write_note`, `append_to_note`, `delete_note`, moves ou qualquer rota generica futura. `vault_admin` nao fura essa regra para criar, editar, append, mover ou deletar conteudo nesse namespace. Se for necessario limpar residuo legado, isso deve ser uma tool admin explicita, auditada, por exemplo `purge_legacy_namespace`.

## Aliases legados

Introduzir `LEGACY_TOOL_MODE=redirect|error`, com default inicial `redirect`.

Em `redirect`, aliases seguros chamam tools v1 internamente e incluem metadados de deprecacao:

```json
{
  "deprecated": true,
  "legacy_tool": "create_journal_entry",
  "redirected_to": "create_journal_event",
  "legacy_tool_mode": "redirect",
  "new_path": "_journal/reno/2026-05-11-atendimento-x.md"
}
```

Mapeamentos:

- `create_journal_entry` -> `create_journal_event`.
- `upsert_entity_profile` -> `create_or_update_entity`.
- `upsert_hub` -> `update_hub`.

Com `LEGACY_TOOL_MODE=error`, esses aliases falham sem escrever.

`append_decision` e excecao: deve sempre falhar com `DEPRECATED_TOOL`, mesmo em `redirect`, sugerindo `record_decision`. A semantica mudou de append em log compilado para nota atomica; redirecionamento silencioso esconderia uma mudanca de contrato.

## Datas

Payloads devem aceitar:

- `YYYY-MM-DD`
- ISO-8601 com timezone

Para novas notas, `created` e `updated` representam a data da escrita no vault, nao a data semantica do fato. Eventos antigos registrados hoje continuam com `created` e `updated` de hoje.

Campos semanticos carregam a data do fato:

- `event_date` para o dia do evento e para o filename de journal.
- `occurred_at` para timestamp ISO quando houver.
- `source_date`, `verified_at` e outros campos especificos preservam sua propria semantica.

`DEFAULT_DATE_STYLE=yyyy-mm-dd` define a emissao padrao de `created` e `updated`.

## Tools v1 canonicas

### `create_journal_event`

Tool principal para o Reno. Destino padrao:

```text
_journal/reno/YYYY-MM-DD-{slug}.md
```

Entradas esperadas: `agent`, `title`, `content`, `event_date?`, `occurred_at?`, `channel?`, `participants?`, `mentions_entity?`, `related?`, `tags?`, `source?`, `confidence?`, `external_ids?`.

Regra de tipo:

- `interaction` quando houver `channel + participants` ou contraparte clara.
- `journal` para auditoria, rotina, plano, log operacional, erro, batch ou medicao.

Se receber ISO-8601 em `occurred_at`, o dia derivado alimenta `event_date` e filename; o timestamp completo fica preservado em `occurred_at`.

### `create_or_update_entity`

Grava em:

```text
_entities/{slug}.md
```

Emite `type: entity`. Reno pode usar a tool com validacao rigida e provenance obrigatoria, sem permissao ampla em `_entities/**`.

Campos permitidos para Reno incluem `aliases`, `external_ids`, `mentions_entity`, `related`, `source`, `confidence`, observacoes/proveniencia, `status` e `entity_type` quando estiver vazio. `entity_type` vira protegido quando ja existir.

Campos protegidos para Reno incluem identidade canonica ja definida, merges destrutivos, `verified_by`, `verified_at`, `source: human-curated`, `superseded_by` e mudancas substantivas de relacionamento canonico. Por padrao, escritas do Reno usam `source: agent-generated`, `author_agent: reno`, `verified_by: null`.

### `record_decision`

Cria nota atomica em `_decisions/`, com `type: decision` e `status: active`.

Path:

- Reno: `_decisions/YYYY-MM-DD-reno-{slug}.md`
- Renato/admin: `_decisions/YYYY-MM-DD-{slug}.md`

Campos minimos:

```yaml
schema_version: 1
type: decision
status: active
decided_by: []
supersedes: []
superseded_by: []
mentions_entity: []
implements: []
related: []
```

### `upsert_runbook`

Reno so pode escrever:

```text
_runbooks/reno-*.md
```

Runbooks gerais/admin usam `_runbooks/runbook-*.md` ou slug livre validado por ownership.

### `update_hub`

Grava em `_hubs/{slug}.md`. Deve ser conservadora: atualizar links, resumos e metadados controlados, sem reescrever o hub inteiro sem diff/preview.

### `validate_note`

Valida um path ou payload sem escrever. Retorno:

```json
{
  "valid": false,
  "errors": [],
  "warnings": [],
  "normalized_frontmatter_preview": {},
  "recommended_tool": "create_journal_event"
}
```

### `validate_vault`

Read-only. Audita o indice e agrupa achados por categorias fixas:

- `schema_error`
- `ownership_violation`
- `legacy_namespace`
- `broken_link`
- `trust_gap`
- `index_policy_gap`
- `routing_gap`
- `frontmatter_missing`

Deve cobrir no minimo: conteudo em `_agents/**`, frontmatter ausente, `schema_version` ausente, `type` invalido, links canonicos antigos, paths fora do roteamento v1, ownership violations e notas `agent-generated` sem provenance minima.

### `find_entity_by_external_id`

Busca em `_entities/**` por `external_ids` e retorna candidatos com path, frontmatter resumido e trust.

## Ownership e guards

Ordem obrigatoria em qualquer escrita:

1. Parse input.
2. `assertNoLegacyNamespaceWrite`.
3. `assertWritableDestination` e ownership.
4. Validacao de schema e routing.
5. Write atomico.

Essa ordem garante que `_agents/**` sempre retorne `LEGACY_NAMESPACE_REMOVED`, nao `OWNERSHIP_VIOLATION`.

Mapa operacional esperado:

```text
_journal/reno/**       => reno
_runbooks/reno-*.md    => reno
_decisions/reno-*.md   => reno
_decisions/*-reno-*.md => reno
_entities/**           => renato, ou Reno via tool controlada
_shared/context/**     => renato
_meta/**               => renato
```

`OWNERSHIP_VIOLATION` continua sendo usado quando o destino e valido, mas o agente nao pode escrever nele.

## Trust e retrieve

`min_trust` deve evoluir para:

- `any`
- `verified`
- `human`

Trust levels padronizados:

- `unverified_agent`
- `agent_verified`
- `human_verified`
- `human_curated`
- `imported_unknown`

`verified` permite `source: human-curated` ou `verified_by` preenchido. O retorno deve incluir `verified_mode`, pois `verified_by: "reno"` e `verified_by: "Renato Faria"` tem pesos diferentes.

`human` permite `source: human-curated` ou `verified_by` em lista reconhecida de humanos. Essa lista vem de config:

```text
HUMAN_VERIFIERS=Renato Faria,...
```

Regra operacional: `source: agent-generated` com `verified_by: null` pode aparecer em busca ampla, mas nao deve ser citado como verdade final quando `min_trust=verified|human`. Quando uma chamada exigir esse nivel e a nota nao passar, usar `TRUST_POLICY_VIOLATION` quando aplicavel.

## Index policy

O MCP deve calcular politica de indexacao como metadado no `VaultIndex`, mesmo antes de existir embedding real:

```json
{
  "vector": true,
  "graph": true,
  "reason": "folder_rule"
}
```

Regra por pasta:

```text
_entities/   -> vector + graph
_hubs/       -> vector + graph
_decisions/  -> vector + graph
_runbooks/   -> vector + graph
_journal/    -> graph only
_meta/       -> none by default
```

Override por status:

```text
draft       -> none
superseded  -> graph only
archived    -> graph only
active      -> folder rule
```

O schema pode aceitar override manual futuro:

```yaml
index_override:
  vector: true
  graph: true
  reason: "golden-query anchor"
```

Nao precisa ser implementado no primeiro corte, mas deve ser aceito sem rejeicao.

## Modulos de implementacao

Criar helpers centrais para evitar regras duplicadas:

- `normalizeDateInput`
- `buildV1Frontmatter`
- `computeIndexPolicy`
- `computeTrustLevel`
- `assertNoLegacyNamespaceWrite`
- `assertWritableDestination`
- `validateV1Note`

Configs:

```text
LEGACY_TOOL_MODE=redirect|error
HUMAN_VERIFIERS=Renato Faria,...
DEFAULT_AGENT_SOURCE=agent-generated
DEFAULT_DATE_STYLE=yyyy-mm-dd
```

Erros novos:

- `LEGACY_NAMESPACE_REMOVED`
- `DEPRECATED_TOOL`
- `ROUTING_VIOLATION`
- `PROTECTED_FIELD_VIOLATION`
- `INVALID_SCHEMA_V1`
- `TRUST_POLICY_VIOLATION`

Erros existentes como `OWNERSHIP_VIOLATION` continuam valendo quando o path nao for legado.

## Testes

Cobertura minima:

- Unitarios para datas `YYYY-MM-DD` e ISO-8601 com timezone.
- Unitarios para frontmatter v1 com campos extras preservados e minimos obrigatorios.
- Unitarios para `computeTrustLevel` e `min_trust`.
- Unitarios para `computeIndexPolicy`.
- Unitarios para bloqueio de `_agents/**`.
- Integracao para `create_journal_event`.
- Integracao para `record_decision`.
- Integracao para `create_or_update_entity` com campos permitidos/protegidos.
- Integracao para aliases legados em `LEGACY_TOOL_MODE=redirect`.
- Integracao para aliases legados em `LEGACY_TOOL_MODE=error`.
- Integracao garantindo que `append_decision` nunca escreve.
- Integracao garantindo que `write_note` para `_agents/foo.md` falha mesmo com `vault_admin`.
- Auditoria para `validate_note` e `validate_vault`.

## Criterios de aceite

- Nenhuma escrita nova em `_agents/**` e possivel por rota normal ou `vault_admin`.
- Tools canonicas emitem Schema v1 minimo valido.
- Aliases seguros redirecionam com aviso enquanto `LEGACY_TOOL_MODE=redirect`.
- `append_decision` falha sempre e aponta `record_decision`.
- Reno consegue registrar eventos em `_journal/reno/`.
- Reno consegue criar/atualizar entidades apenas por tool controlada, com provenance e campos protegidos.
- `min_trust` impede uso de nota `agent-generated` nao verificada como verdade final.
- `validate_vault` reporta gaps de schema, trust, roteamento, ownership, links e namespace legado.
