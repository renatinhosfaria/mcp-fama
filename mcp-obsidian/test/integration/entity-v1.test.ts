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

async function createOrUpdateEntity(args: Record<string, unknown>) {
  const fn = (workflows as any).createOrUpdateEntity;
  if (typeof fn !== 'function') throw new Error('createOrUpdateEntity not implemented');
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

describe('create_or_update_entity', () => {
  it('lets Reno create a Schema v1 entity in _entities with provenance', async () => {
    const r = await createOrUpdateEntity({
      as_agent: 'reno',
      name: 'Bruno Sávio',
      entity_type: 'person',
      content: '# Bruno Sávio\n',
      tags: ['people'],
    });

    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_entities/bruno-savio.md');
    expect(sc.created_or_updated).toBe('created');
    track(sc.path);

    const parsed = parseFrontmatter(fs.readFileSync(abs(sc.path), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      schema_version: 1,
      type: 'entity',
      status: 'active',
      source: 'agent-generated',
      tags: ['people'],
      author_agent: 'reno',
      name: 'Bruno Sávio',
      entity_type: 'person',
      verified_by: null,
    });
  });

  it('prevents Reno from changing an existing entity_type', async () => {
    const rel = '_entities/ana-teste.md';
    fs.mkdirSync(path.dirname(track(rel)), { recursive: true });
    fs.writeFileSync(track(rel), serializeFrontmatter({
      schema_version: 1,
      type: 'entity',
      status: 'active',
      created: '2026-05-10',
      updated: '2026-05-10',
      source: 'agent-generated',
      tags: [],
      author_agent: 'reno',
      name: 'Ana Teste',
      entity_type: 'person',
      verified_by: null,
    }, '# Ana Teste\n'));

    const r = await createOrUpdateEntity({
      as_agent: 'reno',
      name: 'Ana Teste',
      entity_type: 'org',
      content: '# Ana Teste\n',
    });

    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('PROTECTED_FIELD_VIOLATION');

    const parsed = parseFrontmatter(fs.readFileSync(abs(rel), 'utf8'));
    expect(parsed.frontmatter?.entity_type).toBe('person');
  });

  it('persists verification fields supplied by an authorized agent', async () => {
    const r = await createOrUpdateEntity({
      as_agent: 'vault_admin',
      name: 'Entidade Verificada',
      entity_type: 'person',
      content: '# Entidade Verificada\n',
      verified_by: 'Renato Faria',
      verified_at: '2026-05-11',
      superseded_by: ['[[Nova Entidade]]'],
    });

    const sc = r.structuredContent as any;
    expect(sc.path).toBe('_entities/entidade-verificada.md');
    track(sc.path);

    const parsed = parseFrontmatter(fs.readFileSync(abs(sc.path), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      verified_by: 'Renato Faria',
      verified_at: '2026-05-11',
      superseded_by: ['[[Nova Entidade]]'],
    });
  });
});

describe('upsert_entity_profile legacy alias', () => {
  it('redirects to create_or_update_entity and reports deprecation metadata', async () => {
    const r = await workflows.upsertEntityProfile({
      as_agent: 'reno',
      entity_type: 'person',
      entity_name: 'Maria X',
      content: '# Maria X\n',
      tags: ['people'],
      status: 'draft',
    }, ctx);

    const sc = r.structuredContent as any;
    expect(sc).toMatchObject({
      path: '_entities/maria-x.md',
      new_path: '_entities/maria-x.md',
      created_or_updated: 'created',
      deprecated: true,
      legacy_tool: 'upsert_entity_profile',
      redirected_to: 'create_or_update_entity',
      legacy_tool_mode: 'redirect',
    });
    track(sc.path);

    const parsed = parseFrontmatter(fs.readFileSync(abs(sc.path), 'utf8'));
    expect(parsed.frontmatter).toMatchObject({
      schema_version: 1,
      type: 'entity',
      status: 'draft',
      author_agent: 'reno',
      name: 'Maria X',
      entity_type: 'person',
    });
    expect(fs.existsSync(abs('_agents/reno/person/maria-x.md'))).toBe(false);
  });
});
