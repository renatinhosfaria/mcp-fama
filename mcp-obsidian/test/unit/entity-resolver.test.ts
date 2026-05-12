import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import {
  EntityResolver,
  ensureHubStub,
  injectVinculosLine,
} from '../../src/vault/entity-resolver.js';

let tmpRoot: string;
let index: VaultIndex;

function writeNote(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeAgentsMap(): void {
  writeNote(
    '_shared/context/AGENTS.md',
    `---\ntype: agents-map\nowner: renato\ncreated: 2026-04-01\nupdated: 2026-04-01\ntags: []\n---\n\`\`\`\n_agents/reno/**         => reno\n_shared/hubs/**         => vault-steward\n**/*                    => vault-steward\n\`\`\`\n`
  );
}

function makeStub(rel: string, fmExtras: Record<string, any> = {}): void {
  const fmLines = [
    'type: hub',
    'owner: vault-steward',
    'created: 2026-04-01',
    'updated: 2026-04-01',
    'tags: []',
    'scope: empreendimento',
    'maintainer: vault-steward',
    'status: active',
    ...Object.entries(fmExtras).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
  ];
  writeNote(rel, `---\n${fmLines.join('\n')}\n---\n# Stub\n`);
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-resolver-'));
  writeAgentsMap();
  // Seed canonical Reno docs to test ID-prefix lookup.
  writeNote(
    '_agents/reno/atendimentos/10930-cassio-coimbra.md',
    `---\ntype: entity-profile\nowner: reno\ncreated: 2026-04-01\nupdated: 2026-04-01\ntags: []\nentity_type: lead\nentity_name: Cassio Coimbra\n---\n# Cassio\n`
  );
  writeNote(
    '_agents/reno/brokers/broker-35-suelen.md',
    `---\ntype: entity-profile\nowner: reno\ncreated: 2026-04-01\nupdated: 2026-04-01\ntags: []\nentity_type: broker\nentity_name: Suelen\n---\n# Suelen\n`
  );
  // Seeds for hub-by-frontmatter-id resolution.
  makeStub('_shared/hubs/empreendimentos/empreendimento-garden-sul.md', {
    empreendimento_id: 42,
    display_name: 'Garden Sul',
  });
  index = new VaultIndex(tmpRoot);
  await index.build();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('EntityResolver — client by id', () => {
  it('finds existing canonical doc by id-prefix', () => {
    const r = new EntityResolver(index).resolve({ kind: 'client', id: 10930 });
    expect(r.found).toBe(true);
    expect(r.path).toBe('_agents/reno/atendimentos/10930-cassio-coimbra.md');
    expect(r.stem).toBe('10930-cassio-coimbra');
  });

  it('returns deterministic placeholder when missing (no stub)', () => {
    const r = new EntityResolver(index).resolve({
      kind: 'client', id: 99999, display_name: 'Novo Cliente',
    });
    expect(r.found).toBe(false);
    expect(r.path).toBe('_agents/reno/atendimentos/99999-novo-cliente.md');
    expect(r.stem).toBe('99999-novo-cliente');
  });
});

describe('EntityResolver — broker by id', () => {
  it('finds existing canonical doc by broker- prefix', () => {
    const r = new EntityResolver(index).resolve({ kind: 'broker', id: 35 });
    expect(r.found).toBe(true);
    expect(r.path).toBe('_agents/reno/brokers/broker-35-suelen.md');
    expect(r.stem).toBe('broker-35-suelen');
  });

  it('placeholder uses broker- prefix', () => {
    const r = new EntityResolver(index).resolve({ kind: 'broker', id: 88 });
    expect(r.found).toBe(false);
    expect(r.stem).toBe('broker-88');
  });
});

describe('EntityResolver — empreendimento', () => {
  it('finds by frontmatter empreendimento_id', () => {
    const r = new EntityResolver(index).resolve({ kind: 'empreendimento', id: 42 });
    expect(r.found).toBe(true);
    expect(r.path).toBe('_shared/hubs/empreendimentos/empreendimento-garden-sul.md');
    expect(r.stem).toBe('empreendimento-garden-sul');
  });

  it('finds by slug deterministically', () => {
    const r = new EntityResolver(index).resolve({
      kind: 'empreendimento', slug: 'garden-sul',
    });
    expect(r.path).toBe('_shared/hubs/empreendimentos/empreendimento-garden-sul.md');
    expect(r.stem).toBe('empreendimento-garden-sul');
    expect(r.found).toBe(true);
  });

  it('does not double-prefix when slug already has empreendimento-', () => {
    const r = new EntityResolver(index).resolve({
      kind: 'empreendimento', slug: 'empreendimento-garden-sul',
    });
    expect(r.stem).toBe('empreendimento-garden-sul');
  });

  it('falls back to id-only path when not in index', () => {
    const r = new EntityResolver(index).resolve({ kind: 'empreendimento', id: 999 });
    expect(r.found).toBe(false);
    expect(r.stem).toBe('empreendimento-999');
  });
});

describe('EntityResolver — fonte / regiao', () => {
  it('fonte deterministic by slug', () => {
    const r = new EntityResolver(index).resolve({ kind: 'fonte', slug: 'facebook-ads' });
    expect(r.path).toBe('_shared/hubs/fontes/facebook-ads.md');
    expect(r.stem).toBe('facebook-ads');
    expect(r.found).toBe(false);
  });

  it('regiao kebab-cases the slug', () => {
    const r = new EntityResolver(index).resolve({ kind: 'regiao', slug: 'Jardim Karaíba' });
    expect(r.stem).toBe('jardim-karaiba');
  });
});

describe('ensureHubStub', () => {
  it('writes a hub/stub note for missing fonte', async () => {
    const resolver = new EntityResolver(index);
    const r = resolver.resolve({ kind: 'fonte', slug: 'facebook-ads' });
    const created = await ensureHubStub({
      resolved: r, vaultRoot: tmpRoot, index, asAgent: 'vault-steward',
    });
    expect(created).toBe(true);
    const txt = fs.readFileSync(path.join(tmpRoot, r.path), 'utf8');
    expect(txt).toMatch(/type: hub/);
    expect(txt).toMatch(/status: stub/);
    expect(txt).toMatch(/scope: fonte/);
    expect(txt).toMatch(/Stub criado automaticamente/);
  });

  it('does not overwrite an existing note', async () => {
    const resolver = new EntityResolver(index);
    const r = resolver.resolve({ kind: 'empreendimento', id: 42 });
    const created = await ensureHubStub({
      resolved: r, vaultRoot: tmpRoot, index, asAgent: 'vault-steward',
    });
    expect(created).toBe(false);
  });

  it('is a no-op for non-hub kinds (client/broker)', async () => {
    const resolver = new EntityResolver(index);
    const r = resolver.resolve({ kind: 'client', id: 99999 });
    const created = await ensureHubStub({
      resolved: r, vaultRoot: tmpRoot, index, asAgent: 'reno',
    });
    expect(created).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, r.path))).toBe(false);
  });
});

describe('injectVinculosLine', () => {
  it('prepends a Vínculos line', () => {
    const out = injectVinculosLine('## Resumo\nbody', ['a', 'b']);
    expect(out.startsWith('Vínculos: [[a]] · [[b]]\n\n')).toBe(true);
  });

  it('replaces an existing Vínculos line', () => {
    const before = injectVinculosLine('## Resumo\nbody', ['old']);
    const after = injectVinculosLine(before, ['new1', 'new2']);
    expect(after).toMatch(/^Vínculos: \[\[new1\]\] · \[\[new2\]\]\n\n## Resumo/);
    expect(after).not.toMatch(/old/);
  });

  it('removes the line when stems list is empty', () => {
    const before = injectVinculosLine('## Resumo\nbody', ['old']);
    const after = injectVinculosLine(before, []);
    expect(after).toBe('## Resumo\nbody');
  });

  it('is idempotent for the same stems', () => {
    const a = injectVinculosLine('## Resumo\nbody', ['x', 'y']);
    const b = injectVinculosLine(a, ['x', 'y']);
    expect(a).toBe(b);
  });
});
