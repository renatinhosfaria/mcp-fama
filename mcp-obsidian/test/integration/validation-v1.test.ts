import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VaultIndex } from '../../src/vault/index.js';
import { serializeFrontmatter } from '../../src/vault/frontmatter.js';
import * as workflows from '../../src/tools/workflows.js';

const FIXTURE = path.resolve('test/fixtures/vault');
const VALIDATION_CATEGORIES = [
  'schema_error',
  'ownership_violation',
  'legacy_namespace',
  'broken_link',
  'trust_gap',
  'index_policy_gap',
  'routing_gap',
  'frontmatter_missing',
];

let ctx: { index: VaultIndex; vaultRoot: string };
const touched = new Set<string>();

function abs(rel: string): string {
  return path.join(FIXTURE, rel);
}

function track(rel: string): string {
  touched.add(rel);
  return abs(rel);
}

function categories(items: any[]): string[] {
  return items.map((item) => item.category);
}

async function createOrUpdateEntity(args: Record<string, unknown>) {
  const fn = (workflows as any).createOrUpdateEntity;
  if (typeof fn !== 'function') throw new Error('createOrUpdateEntity not implemented');
  return await fn(args, ctx);
}

async function validateNote(args: Record<string, unknown>) {
  const fn = (workflows as any).validateNote;
  if (typeof fn !== 'function') throw new Error('validateNote not implemented');
  return await fn(args, ctx);
}

async function validateVault(args: Record<string, unknown> = {}) {
  const fn = (workflows as any).validateVault;
  if (typeof fn !== 'function') throw new Error('validateVault not implemented');
  return await fn(args, ctx);
}

async function findEntityByExternalId(args: Record<string, unknown>) {
  const fn = (workflows as any).findEntityByExternalId;
  if (typeof fn !== 'function') throw new Error('findEntityByExternalId not implemented');
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

  for (const rel of ['_agents/reno', '_entities']) {
    const p = abs(rel);
    if (fs.existsSync(p) && fs.readdirSync(p).length === 0) {
      fs.rmdirSync(p);
    }
  }
});

describe('validation v1 tools', () => {
  it('validate_note reports legacy namespace, missing frontmatter, and recommended journal tool', async () => {
    const r = await validateNote({
      path: '_agents/reno/old.md',
      content: 'legacy body without frontmatter',
    });

    const sc = r.structuredContent as any;
    expect(sc.valid).toBe(false);
    expect(categories(sc.errors)).toEqual(expect.arrayContaining(['legacy_namespace', 'frontmatter_missing']));
    expect(sc.warnings).toEqual([]);
    expect(sc.normalized_frontmatter_preview).toEqual({});
    expect(sc.recommended_tool).toBe('create_journal_event');
  });

  it('validate_vault returns all fixed categories and count keys', async () => {
    const r = await validateVault();
    const sc = r.structuredContent as any;

    expect(sc.categories).toEqual(VALIDATION_CATEGORIES);
    expect(Object.keys(sc.counts).sort()).toEqual([...VALIDATION_CATEGORIES].sort());
    for (const category of VALIDATION_CATEGORIES) {
      expect(typeof sc.counts[category]).toBe('number');
    }
  });

  it('find_entity_by_external_id only returns matching entities from _entities', async () => {
    const created = await createOrUpdateEntity({
      as_agent: 'reno',
      name: 'Bruno Sávio',
      entity_type: 'person',
      content: '# Bruno Sávio\n',
      external_ids: { crm: 'bruno-42' },
    });
    const createdPath = (created.structuredContent as any).path;
    expect(createdPath).toBe('_entities/bruno-savio.md');
    track(createdPath);

    const legacyRel = '_agents/reno/old-external-id.md';
    fs.mkdirSync(path.dirname(track(legacyRel)), { recursive: true });
    fs.writeFileSync(abs(legacyRel), serializeFrontmatter({
      schema_version: 1,
      type: 'entity',
      status: 'active',
      created: '2026-05-11',
      updated: '2026-05-11',
      source: 'agent-generated',
      tags: [],
      author_agent: 'reno',
      name: 'Legacy Bruno',
      entity_type: 'person',
      external_ids: { crm: 'bruno-42' },
    }, '# Legacy Bruno\n'));
    await ctx.index.updateAfterWrite(legacyRel);

    const r = await findEntityByExternalId({ key: 'crm', value: 'bruno-42' });
    const sc = r.structuredContent as any;

    expect(sc.candidates.map((candidate: any) => candidate.path)).toEqual(['_entities/bruno-savio.md']);
    expect(sc.candidates[0].frontmatter).toMatchObject({
      type: 'entity',
      name: 'Bruno Sávio',
      entity_type: 'person',
      external_ids: { crm: 'bruno-42' },
    });
    expect(sc.candidates[0].trust.trust_level).toBe('unverified_agent');
  });
});
