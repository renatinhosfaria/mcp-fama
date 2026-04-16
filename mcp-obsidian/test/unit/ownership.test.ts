import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseOwnershipMap, resolveOwner, OwnershipMap, OwnershipResolver } from '../../src/vault/ownership.js';

const FIXTURE = path.resolve('test/fixtures/AGENTS.md');

describe('parseOwnershipMap', () => {
  it('parses pattern => agent lines from fenced block', () => {
    const map = parseOwnershipMap(fs.readFileSync(FIXTURE, 'utf8'));
    expect(map.length).toBeGreaterThan(0);
    expect(map.find(p => p.pattern === '_agents/alfa/**' && p.agent === 'alfa')).toBeTruthy();
    expect(map.find(p => p.pattern === 'README.md' && p.agent === 'renato')).toBeTruthy();
  });

  it('ignores text outside fenced blocks', () => {
    const src = "prose\n```\n_agents/x/** => x\n```\nmore prose with => arrows that should not match";
    const map = parseOwnershipMap(src);
    expect(map).toEqual([{ pattern: '_agents/x/**', agent: 'x' }]);
  });

  it('returns empty list when no fenced blocks', () => {
    expect(parseOwnershipMap('# just text')).toEqual([]);
  });
});

describe('resolveOwner', () => {
  const map: OwnershipMap = [
    { pattern: '_agents/alfa/**', agent: 'alfa' },
    { pattern: '_agents/beta/**', agent: 'beta' },
    { pattern: '_shared/goals/*/alfa.md', agent: 'alfa' },
    { pattern: '_shared/context/*/alfa/**', agent: 'alfa' },
    { pattern: 'README.md', agent: 'renato' },
  ];

  it('matches exact path', () => {
    expect(resolveOwner('README.md', map)).toBe('renato');
  });
  it('matches recursive glob', () => {
    expect(resolveOwner('_agents/alfa/decisions.md', map)).toBe('alfa');
    expect(resolveOwner('_agents/alfa/journal/2026-04-16-x.md', map)).toBe('alfa');
  });
  it('matches mid-path wildcard', () => {
    expect(resolveOwner('_shared/goals/2026-04/alfa.md', map)).toBe('alfa');
    expect(resolveOwner('_shared/context/objecoes/alfa/x.md', map)).toBe('alfa');
  });
  it('returns null for unmapped path', () => {
    expect(resolveOwner('_agents/gamma/x.md', map)).toBeNull();
  });
  it('first matching pattern wins (order matters)', () => {
    const m: OwnershipMap = [
      { pattern: '_agents/alfa/special.md', agent: 'special-owner' },
      { pattern: '_agents/alfa/**', agent: 'alfa' },
    ];
    expect(resolveOwner('_agents/alfa/special.md', m)).toBe('special-owner');
    expect(resolveOwner('_agents/alfa/other.md', m)).toBe('alfa');
  });
});

describe('OwnershipResolver (lazy mtime reload)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-own-'));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), "```\n_agents/alfa/** => alfa\n```");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resolves from initial parse', async () => {
    const r = new OwnershipResolver(path.join(tmp, 'AGENTS.md'));
    expect(await r.resolve('_agents/alfa/x.md')).toBe('alfa');
    expect(await r.resolve('_agents/beta/x.md')).toBeNull();
  });

  it('re-parses when AGENTS.md mtime changes', async () => {
    const r = new OwnershipResolver(path.join(tmp, 'AGENTS.md'));
    expect(await r.resolve('_agents/beta/x.md')).toBeNull();
    await new Promise(res => setTimeout(res, 10));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), "```\n_agents/alfa/** => alfa\n_agents/beta/** => beta\n```");
    expect(await r.resolve('_agents/beta/x.md')).toBe('beta');
  });

  it('listAgents returns unique sorted owners', async () => {
    const r = new OwnershipResolver(path.join(tmp, 'AGENTS.md'));
    expect(await r.listAgents()).toEqual(['alfa']);
  });
});
