import { minimatch } from 'minimatch';
import { promises as fsp } from 'node:fs';
import { McpError } from '../errors.js';

export interface OwnershipPattern { pattern: string; agent: string; }
export type OwnershipMap = OwnershipPattern[];

const FENCE_RE = /```[a-z]*\n([\s\S]*?)```/gi;
const LINE_RE = /^([^\s=]+)\s*=>\s*([a-z][a-z0-9-]*)\s*$/i;

export function parseOwnershipMap(src: string): OwnershipMap {
  const out: OwnershipMap = [];
  for (const m of src.matchAll(FENCE_RE)) {
    for (const raw of m[1].split('\n')) {
      const lm = raw.match(LINE_RE);
      if (lm) out.push({ pattern: lm[1].trim(), agent: lm[2].trim() });
    }
  }
  return out;
}

export function resolveOwner(relPath: string, map: OwnershipMap): string | null {
  for (const { pattern, agent } of map) {
    if (minimatch(relPath, pattern, { dot: true })) return agent;
  }
  return null;
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

  async listAgents(): Promise<string[]> {
    await this.ensureFresh();
    return [...new Set(this.map.map(p => p.agent))].sort();
  }

  async getMap(): Promise<OwnershipMap> {
    await this.ensureFresh();
    return [...this.map];
  }
}
