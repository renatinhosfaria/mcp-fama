import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/vault/frontmatter.js';
import * as workflows from '../../src/tools/workflows.js';

const FIXTURE = path.resolve('test/fixtures/vault');

let ctx: { index: VaultIndex; vaultRoot: string };
const touched = new Set<string>();

function abs(rel: string): string {
  return path.join(FIXTURE, rel);
}

function track(rel: string): string {
  touched.add(rel);
  return abs(rel);
}

async function updateHub(args: Record<string, unknown>) {
  const fn = (workflows as any).updateHub;
  if (typeof fn !== 'function') throw new Error('updateHub not implemented');
  return await fn(args, ctx);
}

async function upsertRunbook(args: Record<string, unknown>) {
  const fn = (workflows as any).upsertRunbook;
  if (typeof fn !== 'function') throw new Error('upsertRunbook not implemented');
  return await fn(args, ctx);
}

beforeEach(async () => {
  const index = new VaultIndex(FIXTURE);
  await index.build();
  ctx = { index, vaultRoot: FIXTURE };
});

afterEach(() => {
  for (const rel of [...touched].reverse()) {
    const p = abs(rel);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  touched.clear();
});

describe('update_hub', () => {
  it('writes a Schema v1 hub in _hubs', async () => {
    track('_hubs/clientes-ativos.md');
    const r = await updateHub({
      as_agent: 'renato',
      slug: 'clientes-ativos',
      title: 'Clientes Ativos',
      summary: 'Visao operacional dos clientes ativos.',
      related: ['[[Cliente A]]'],
      tags: ['operacao'],
    });

    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_hubs/clientes-ativos.md');
    expect(sc.created_or_updated).toBe('created');

    const parsed = parseFrontmatter(fs.readFileSync(abs(sc.path), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      schema_version: 1,
      type: 'hub',
      status: 'active',
      source: 'agent-generated',
      tags: ['operacao'],
      author_agent: 'renato',
      title: 'Clientes Ativos',
      scope: 'hub',
      maintainer: 'renato',
      summary: 'Visao operacional dos clientes ativos.',
      related: ['[[Cliente A]]'],
    });
    expect(parsed.body).toContain('## Summary');
    expect(parsed.body).toContain('Visao operacional dos clientes ativos.');
    expect(parsed.body).toContain('## Related');
    expect(parsed.body).toContain('- [[Cliente A]]');
  });

  it('updates Summary outside fenced code blocks only', async () => {
    const rel = '_hubs/fenced-summary.md';
    track(rel);
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), serializeFrontmatter({
      schema_version: 1,
      type: 'hub',
      status: 'active',
      created: '2026-05-10',
      updated: '2026-05-10',
      source: 'agent-generated',
      tags: [],
      author_agent: 'renato',
      title: 'Fenced Summary',
      scope: 'hub',
      maintainer: 'renato',
    }, '# Fenced Summary\n\n```md\n## Summary\nmust remain inside fence\n```\n'));

    const r = await updateHub({
      as_agent: 'renato',
      slug: 'fenced-summary',
      title: 'Fenced Summary',
      summary: 'Real summary outside the fence.',
    });

    expect((r.structuredContent as any).path).toBe(rel);
    const parsed = parseFrontmatter(fs.readFileSync(abs(rel), 'utf8'));
    expect(parsed.body).toContain('```md\n## Summary\nmust remain inside fence\n```');
    expect(parsed.body).toContain('## Summary\n\nReal summary outside the fence.');
  });
});

describe('upsert_runbook', () => {
  it('allows Reno only on reno-prefixed runbook slugs', async () => {
    track('_runbooks/reno-registro-vault.md');
    const allowed = await upsertRunbook({
      as_agent: 'reno',
      slug: 'reno-registro-vault',
      title: 'Registro no Vault',
      content: '## Procedure\n\nRegistrar evento no vault com apoio do [[reno-hub]].\n',
      tags: ['processo'],
    });

    const allowedSc = allowed.structuredContent as any;
    expect(allowedSc.path).toBe('_runbooks/reno-registro-vault.md');
    expect(allowedSc.created_or_updated).toBe('created');

    const parsed = parseFrontmatter(fs.readFileSync(abs(allowedSc.path), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      schema_version: 1,
      type: 'runbook',
      status: 'active',
      source: 'agent-generated',
      tags: ['processo'],
      author_agent: 'reno',
      title: 'Registro no Vault',
      procedure_owner: 'reno',
      trigger: 'manual',
    });

    const blocked = await upsertRunbook({
      as_agent: 'reno',
      slug: 'runbook-geral',
      title: 'Runbook Geral',
      content: 'Nao deve escrever.\n',
    });

    expect(blocked.isError).toBe(true);
    expect((blocked.structuredContent as any).error.code).toBe('ROUTING_VIOLATION');
    expect(fs.existsSync(abs('_runbooks/runbook-geral.md'))).toBe(false);
  });
});

describe('upsert_hub legacy alias', () => {
  it('redirects to update_hub and writes to _hubs only', async () => {
    track('_hubs/facebook-ads.md');
    touched.add('_shared/hubs/fontes/facebook-ads.md');
    const r = await workflows.upsertHub({
      as_agent: 'renato',
      hub_type: 'fonte',
      display_name: 'Facebook Ads',
      body: 'Canal pago para aquisicao.',
      tags: ['ads'],
    }, ctx);

    const sc = r.structuredContent as any;
    expect(sc).toMatchObject({
      path: '_hubs/facebook-ads.md',
      new_path: '_hubs/facebook-ads.md',
      created_or_updated: 'created',
      deprecated: true,
      legacy_tool: 'upsert_hub',
      redirected_to: 'update_hub',
      legacy_tool_mode: 'redirect',
    });

    expect(fs.existsSync(abs('_hubs/facebook-ads.md'))).toBe(true);
    expect(fs.existsSync(abs('_shared/hubs/fontes/facebook-ads.md'))).toBe(false);

    const parsed = parseFrontmatter(fs.readFileSync(abs(sc.path), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      schema_version: 1,
      type: 'hub',
      title: 'Facebook Ads',
      author_agent: 'renato',
      summary: 'Canal pago para aquisicao.',
    });
  });

  it('preserves existing hub tags when legacy caller omits tags', async () => {
    const rel = '_hubs/tag-preserve.md';
    track(rel);
    await updateHub({
      as_agent: 'renato',
      slug: 'tag-preserve',
      title: 'Tag Preserve',
      tags: ['keep'],
    });

    const r = await workflows.upsertHub({
      as_agent: 'renato',
      hub_type: 'fonte',
      slug: 'tag-preserve',
      display_name: 'Tag Preserve',
      body: 'Updated summary.',
    }, ctx);

    expect((r.structuredContent as any).path).toBe(rel);
    const parsed = parseFrontmatter(fs.readFileSync(abs(rel), 'utf8'));
    expect(parsed.frontmatter?.tags).toEqual(['keep']);
  });
});
