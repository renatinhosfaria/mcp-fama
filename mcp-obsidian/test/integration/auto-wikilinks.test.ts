import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { parseFrontmatter } from '../../src/vault/frontmatter.js';
import {
  upsertLeadTimeline,
  appendLeadInteraction,
  upsertBrokerProfile,
  upsertHub,
} from '../../src/tools/workflows.js';
import type { McpToolResponse } from '../../src/errors.js';

let tmpRoot: string;
let ctx: { index: VaultIndex; vaultRoot: string };

function writeNote(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(tmpRoot, rel));
}

function read(rel: string): string {
  return fs.readFileSync(path.join(tmpRoot, rel), 'utf8');
}

function errorCode(r: McpToolResponse): string | undefined {
  return (r.structuredContent as any).error?.code;
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-autowl-'));
  writeNote(
    '_shared/context/AGENTS.md',
    `---\ntype: agents-map\nowner: renato\ncreated: 2026-04-01\nupdated: 2026-04-01\ntags: []\n---\n\`\`\`\n_agents/reno/**         => reno\n_journal/reno/**        => reno\n_hubs/reno-hub.md       => reno\n_hubs/**                => vault-steward\n_entities/**            => vault-steward (primary) | reno (confirmed-facts)\n_shared/hubs/**         => vault-steward\n**/*                    => vault-steward\n\`\`\`\n`
  );
  writeNote(
    '_hubs/reno-hub.md',
    `---\nschema_version: 1\ntype: hub\nstatus: active\ncreated: 2026-04-01\nupdated: 2026-04-01\nsource: agent-generated\nauthor_agent: reno\ntags: []\ntitle: Reno Hub\nscope: reno\nmaintainer: reno\n---\n# Reno Hub\n`
  );
  const index = new VaultIndex(tmpRoot);
  await index.build();
  ctx = { index, vaultRoot: tmpRoot };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('legacy auto-wikilink workflows under Schema v1', () => {
  it('upsert_lead_timeline writes a v1 entity without _agents notes or legacy hub stubs', async () => {
    const r = await upsertLeadTimeline({
      as_agent: 'reno',
      lead_name: 'Cliente Teste',
      resumo: 'lead novo',
      broker_id: 35,
      fonte: 'facebook-ads',
      regiao: 'jardim-karaiba',
    }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_entities/cliente-teste.md');
    expect(exists('_entities/cliente-teste.md')).toBe(true);
    expect(exists('_agents/reno/lead/cliente-teste.md')).toBe(false);
    expect(exists('_shared/hubs/fontes/facebook-ads.md')).toBe(false);
    expect(exists('_shared/hubs/regioes/jardim-karaiba.md')).toBe(false);
  });

  it('append_lead_interaction writes a v1 journal event after the entity exists', async () => {
    await upsertLeadTimeline({
      as_agent: 'reno',
      lead_name: 'AppendLead',
      resumo: 'lead novo',
    }, ctx);

    const r = await appendLeadInteraction({
      as_agent: 'reno',
      lead_name: 'AppendLead',
      channel: 'whatsapp',
      summary: 'visita',
      broker_id: 35,
      fonte: 'facebook-ads',
      tags: ['#lead_quente', '#contato_2026-04-01'],
    }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.entity_path).toBe('_entities/appendlead.md');
    expect(sc.path).toMatch(/^_journal\/reno\/\d{4}-\d{2}-\d{2}-appendlead-visita\.md$/);
    expect(exists(sc.path)).toBe(true);
    expect(exists('_agents/reno/lead/appendlead.md')).toBe(false);
    expect(exists('_shared/hubs/fontes/facebook-ads.md')).toBe(false);
  });

  it('upsert_broker_profile writes a v1 entity without broker notes or legacy hub stubs', async () => {
    const r = await upsertBrokerProfile({
      as_agent: 'reno',
      broker_name: 'Carlos',
      broker_id: 99,
      empreendimento_id: 50,
      empreendimento_name: 'Riviera Park',
      regiao: 'jardim-karaiba',
    }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_entities/carlos.md');
    expect(exists('_entities/carlos.md')).toBe(true);
    expect(exists('_agents/reno/broker/carlos.md')).toBe(false);
    expect(exists('_shared/hubs/empreendimentos/empreendimento-riviera-park.md')).toBe(false);
    expect(exists('_shared/hubs/regioes/jardim-karaiba.md')).toBe(false);
  });
});

describe('upsert_hub legacy alias under Schema v1', () => {
  it('redirects to update_hub and writes an active hub in _hubs', async () => {
    const r = await upsertHub({
      as_agent: 'vault-steward',
      hub_type: 'fonte',
      slug: 'google-ads',
      display_name: 'Google Ads',
      status: 'active',
      body: 'Canal pago para aquisicao.',
      tags: ['ads'],
    }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc).toMatchObject({
      path: '_hubs/google-ads.md',
      new_path: '_hubs/google-ads.md',
      created_or_updated: 'created',
      deprecated: true,
      legacy_tool: 'upsert_hub',
      redirected_to: 'update_hub',
      legacy_tool_mode: 'redirect',
    });
    expect(exists('_shared/hubs/fontes/google-ads.md')).toBe(false);

    const parsed = parseFrontmatter(read(sc.path));
    expect(parsed.frontmatter).toMatchObject({
      schema_version: 1,
      type: 'hub',
      status: 'active',
      source: 'agent-generated',
      tags: ['ads'],
      author_agent: 'vault-steward',
      title: 'Google Ads',
      scope: 'hub',
      maintainer: 'vault-steward',
      summary: 'Canal pago para aquisicao.',
    });
  });

  it('updates an existing v1 hub while preserving created date', async () => {
    const created = await upsertHub({
      as_agent: 'vault-steward',
      hub_type: 'regiao',
      slug: 'centro',
      display_name: 'Centro',
    }, ctx);
    const createdSc = created.structuredContent as any;
    const first = parseFrontmatter(read(createdSc.path));
    const createdDate = first.frontmatter?.created;

    const updated = await upsertHub({
      as_agent: 'vault-steward',
      hub_type: 'regiao',
      slug: 'centro',
      display_name: 'Centro Atualizado',
      status: 'archived',
    }, ctx);

    expect(updated.isError).toBeUndefined();
    const updatedSc = updated.structuredContent as any;
    expect(updatedSc).toMatchObject({
      path: '_hubs/centro.md',
      new_path: '_hubs/centro.md',
      created_or_updated: 'updated',
      deprecated: true,
      redirected_to: 'update_hub',
    });

    const parsed = parseFrontmatter(read(updatedSc.path));
    expect(parsed.frontmatter?.created).toBe(createdDate);
    expect(parsed.frontmatter?.updated).toBeDefined();
    expect(parsed.frontmatter?.status).toBe('archived');
    expect(parsed.frontmatter?.title).toBe('Centro Atualizado');
    expect(exists('_shared/hubs/regioes/centro.md')).toBe(false);
  });

  it('infers a v1 hub slug from display_name instead of using old hub-type validation', async () => {
    const r = await upsertHub({
      as_agent: 'vault-steward',
      hub_type: 'empreendimento',
      display_name: 'Sem Slug',
    }, ctx);

    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_hubs/sem-slug.md');
    expect(sc.deprecated).toBe(true);
    expect(exists('_hubs/sem-slug.md')).toBe(true);
    expect(exists('_shared/hubs/empreendimentos/sem-slug.md')).toBe(false);
  });
});
