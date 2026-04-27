// src/vault/index.ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { OwnershipResolver } from './ownership.js';

export interface IndexEntry {
  path: string;
  type: string | null;
  owner: string | null;
  tags: string[];
  wikilinks: string[];
  mtimeMs: number;
  bytes: number;
  updated: string | null;
  frontmatter: Record<string, any> | null;
}

const WIKILINK_RE = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;

export class VaultIndex {
  private entries = new Map<string, IndexEntry>();
  private byTagMap = new Map<string, Set<string>>();
  private byTypeMap = new Map<string, Set<string>>();
  private byOwnerMap = new Map<string, Set<string>>();
  private backlinkMap = new Map<string, Set<string>>();
  private builtAt = 0;
  private ownership: OwnershipResolver;

  constructor(public readonly vaultRoot: string) {
    this.ownership = new OwnershipResolver(path.join(vaultRoot, '_shared/context/AGENTS.md'));
  }

  async build(): Promise<void> {
    this.entries.clear(); this.byTagMap.clear(); this.byTypeMap.clear();
    this.byOwnerMap.clear(); this.backlinkMap.clear();
    await this.walk(this.vaultRoot);
    this.builtAt = Date.now();
  }

  private async walk(dir: string): Promise<void> {
    let names: string[];
    try { names = await fsp.readdir(dir); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full);
      if (st.isDirectory()) await this.walk(full);
      else if (name.endsWith('.md')) await this.indexFile(full, st.mtimeMs, st.size);
    }
  }

  private async indexFile(absPath: string, mtimeMs: number, bytes: number): Promise<void> {
    const rel = path.relative(this.vaultRoot, absPath).split(path.sep).join('/');
    const src = await fsp.readFile(absPath, 'utf8');
    let frontmatter: Record<string, any> | null = null;
    try { frontmatter = parseFrontmatter(src).frontmatter; }
    catch { frontmatter = null; }

    const owner = await this.ownership.resolve(rel).catch(() => null);
    const tags: string[] = Array.isArray(frontmatter?.tags) ? frontmatter!.tags : [];
    const type: string | null = (frontmatter?.type as string) ?? null;
    const updated: string | null = (frontmatter?.updated as string) ?? null;

    const wikilinks: string[] = [];
    for (const m of src.matchAll(WIKILINK_RE)) wikilinks.push(m[1].trim());

    const entry: IndexEntry = { path: rel, type, owner, tags, wikilinks, mtimeMs, bytes, updated, frontmatter };
    this.entries.set(rel, entry);

    if (type) addTo(this.byTypeMap, type, rel);
    if (owner) addTo(this.byOwnerMap, owner, rel);
    for (const t of tags) addTo(this.byTagMap, t, rel);
    for (const w of wikilinks) {
      const stem = w.split('/').pop()!.replace(/\.md$/, '');
      addTo(this.backlinkMap, stem, rel);
      addTo(this.backlinkMap, w, rel);
    }
  }

  get(rel: string): IndexEntry | undefined { return this.entries.get(rel); }
  allEntries(): IndexEntry[] { return [...this.entries.values()]; }
  byTag(tag: string): IndexEntry[] { return [...(this.byTagMap.get(tag) ?? [])].map(p => this.entries.get(p)!); }
  byType(type: string): IndexEntry[] { return [...(this.byTypeMap.get(type) ?? [])].map(p => this.entries.get(p)!); }
  byOwner(owner: string): IndexEntry[] { return [...(this.byOwnerMap.get(owner) ?? [])].map(p => this.entries.get(p)!); }
  backlinks(noteName: string): IndexEntry[] {
    const stem = noteName.replace(/\.md$/, '').split('/').pop()!;
    return [...(this.backlinkMap.get(stem) ?? this.backlinkMap.get(noteName) ?? [])].map(p => this.entries.get(p)!);
  }
  ageMs(): number { return Date.now() - this.builtAt; }
  size(): number { return this.entries.size; }
  countsByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [t, set] of this.byTypeMap) out[t] = set.size;
    return out;
  }
  countsByAgent(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [a, set] of this.byOwnerMap) out[a] = set.size;
    return out;
  }
  getOwnershipResolver(): OwnershipResolver { return this.ownership; }

  async refreshIfStale(rel: string): Promise<void> {
    const abs = path.join(this.vaultRoot, rel);
    let st;
    try { st = await fsp.stat(abs); }
    catch { this.removeEntry(rel); return; }
    const cached = this.entries.get(rel);
    if (cached && cached.mtimeMs === st.mtimeMs) return;
    await this.indexFile(abs, st.mtimeMs, st.size);
  }

  async updateAfterWrite(rel: string): Promise<void> {
    this.removeEntry(rel);
    const abs = path.join(this.vaultRoot, rel);
    let st;
    try { st = await fsp.stat(abs); }
    catch { return; }
    await this.indexFile(abs, st.mtimeMs, st.size);
  }

  removePath(rel: string): void { this.removeEntry(rel); }

  async refreshPaths(paths: string[]): Promise<void> {
    for (const rel of paths) {
      this.removeEntry(rel);
      const abs = path.join(this.vaultRoot, rel);
      let st;
      try { st = await fsp.stat(abs); }
      catch { continue; }
      if (!rel.endsWith('.md')) continue;
      await this.indexFile(abs, st.mtimeMs, st.size);
    }
  }

  private removeEntry(rel: string): void {
    const e = this.entries.get(rel);
    if (!e) return;
    if (e.type) this.byTypeMap.get(e.type)?.delete(rel);
    if (e.owner) this.byOwnerMap.get(e.owner)?.delete(rel);
    for (const t of e.tags) this.byTagMap.get(t)?.delete(rel);
    for (const w of e.wikilinks) {
      const stem = w.split('/').pop()!.replace(/\.md$/, '');
      this.backlinkMap.get(stem)?.delete(rel);
      this.backlinkMap.get(w)?.delete(rel);
    }
    this.entries.delete(rel);
  }
}

function addTo(map: Map<string, Set<string>>, key: string, val: string): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(val);
}
