import { minimatch } from 'minimatch';
import { promises as fsp } from 'node:fs';
import { McpError } from '../errors.js';

export interface OwnershipDelegate { agent: string; scope?: string; }
export interface OwnershipPattern { pattern: string; agent: string; delegates?: OwnershipDelegate[]; }
export type OwnershipMap = OwnershipPattern[];

const FENCE_RE = /```[a-z]*\n([\s\S]*?)```/gi;
const LINE_RE = /^\s*([^\s=]+)\s*=>\s*(.+?)\s*$/i;
const ACTOR_RE = /^([a-z][a-z0-9-]*)(?:\s*\(([^)]+)\))?$/i;

function parseActor(raw: string): OwnershipDelegate | null {
  const m = raw.trim().match(ACTOR_RE);
  if (!m) return null;
  const scope = m[2]?.trim();
  return scope ? { agent: m[1].trim(), scope } : { agent: m[1].trim() };
}

export function parseOwnershipMap(src: string): OwnershipMap {
  const out: OwnershipMap = [];
  for (const m of src.matchAll(FENCE_RE)) {
    for (const raw of m[1].split('\n')) {
      const lm = raw.match(LINE_RE);
      if (!lm) continue;
      const actors = lm[2].split('|').map(parseActor);
      if (actors.some(a => a === null)) continue;
      const parsedActors = actors as OwnershipDelegate[];
      if (parsedActors.length === 0) continue;

      const primary = parsedActors.find(a => a.scope?.toLowerCase() === 'primary') ?? parsedActors[0];
      const delegates = parsedActors.filter(a => a !== primary);
      out.push({
        pattern: lm[1].trim(),
        agent: primary.agent,
        ...(delegates.length > 0 ? { delegates } : {}),
      });
    }
  }
  return out;
}

export function resolveOwnership(relPath: string, map: OwnershipMap): OwnershipPattern | null {
  for (const entry of map) {
    if (minimatch(relPath, entry.pattern, { dot: true })) return entry;
  }
  return null;
}

export function resolveOwner(relPath: string, map: OwnershipMap): string | null {
  return resolveOwnership(relPath, map)?.agent ?? null;
}

export interface OwnershipAccess {
  owner: string | null;
  allowed: boolean;
  scope?: string;
}

export function resolveAccess(relPath: string, asAgent: string, map: OwnershipMap): OwnershipAccess {
  const entry = resolveOwnership(relPath, map);
  if (!entry) return { owner: null, allowed: false };
  if (entry.agent === asAgent) return { owner: entry.agent, allowed: true, scope: 'primary' };
  const delegate = entry.delegates?.find(d => d.agent === asAgent);
  return { owner: entry.agent, allowed: Boolean(delegate), scope: delegate?.scope };
}

export class OwnershipResolver {
  private map: OwnershipMap = [];
  private mtimeMs = 0;
  private loaded = false;

  constructor(private readonly agentsMdPath: string) {}

  private async ensureFresh(): Promise<void> {
    let st;
    try { st = await fsp.stat(this.agentsMdPath); }
    catch (e: any) {
      if (e.code === 'ENOENT') throw new McpError('VAULT_IO_ERROR', `AGENTS.md not found at ${this.agentsMdPath}`);
      throw new McpError('VAULT_IO_ERROR', e.message);
    }
    if (this.loaded && st.mtimeMs === this.mtimeMs) return;
    const src = await fsp.readFile(this.agentsMdPath, 'utf8');
    this.map = parseOwnershipMap(src);
    this.mtimeMs = st.mtimeMs;
    this.loaded = true;
  }

  async resolve(relPath: string): Promise<string | null> {
    await this.ensureFresh();
    return resolveOwner(relPath, this.map);
  }

  async resolveAccess(relPath: string, asAgent: string): Promise<OwnershipAccess> {
    await this.ensureFresh();
    return resolveAccess(relPath, asAgent, this.map);
  }

  async listAgents(): Promise<string[]> {
    await this.ensureFresh();
    return [...new Set(this.map.flatMap(p => [p.agent, ...(p.delegates?.map(d => d.agent) ?? [])]))].sort();
  }

  async getMap(): Promise<OwnershipMap> {
    await this.ensureFresh();
    return [...this.map];
  }
}
