// src/vault/entity-resolver.ts
//
// Resolves entity references (client_id, broker_id, empreendimento_id, fonte,
// regiao) to canonical vault paths and wikilink stems. Used by lead/broker
// workflows and upsert_hub to populate wikilinks deterministically.
//
// Conventions (filename → wikilink stem):
//   client_id=N         → _agents/reno/atendimentos/{N}-{slug}.md
//   broker_id=N         → _agents/reno/brokers/broker-{N}-{slug}.md
//   empreendimento_id=N → _shared/hubs/empreendimentos/empreendimento-{slug}.md
//   fonte=slug          → _shared/hubs/fontes/{slug}.md
//   regiao=slug         → _shared/hubs/regioes/{slug}.md
//
// Hub kinds (empreendimento, fonte, regiao) auto-create a `type: hub`,
// `status: stub` note when the resolver cannot find an existing match.
// Client/broker references that miss return a deterministic placeholder
// path/stem; the canonical doc is created via upsert_lead_timeline /
// upsert_broker_profile in the normal workflow.

import path from 'node:path';
import { VaultIndex } from './index.js';
import { writeFileAtomic, statFile, safeJoin, toKebabSlug } from './fs.js';
import { serializeFrontmatter } from './frontmatter.js';

export type EntityKind = 'client' | 'broker' | 'empreendimento' | 'fonte' | 'regiao';

export interface EntityRef {
  kind: EntityKind;
  id?: number;
  slug?: string;
  display_name?: string;
}

export interface ResolvedEntity {
  ref: EntityRef;
  path: string;
  stem: string;
  found: boolean;
}

const HUB_KINDS = new Set<EntityKind>(['empreendimento', 'fonte', 'regiao']);

export function isHubKind(kind: EntityKind): boolean {
  return HUB_KINDS.has(kind);
}

export const ENTITY_LAYOUT: Record<EntityKind, { dir: string; prefix: string }> = {
  client:         { dir: '_agents/reno/atendimentos',           prefix: '' },
  broker:         { dir: '_agents/reno/brokers',                prefix: 'broker-' },
  empreendimento: { dir: '_shared/hubs/empreendimentos',        prefix: 'empreendimento-' },
  fonte:          { dir: '_shared/hubs/fontes',                 prefix: '' },
  regiao:         { dir: '_shared/hubs/regioes',                prefix: '' },
};

export class EntityResolver {
  constructor(private readonly index: VaultIndex) {}

  resolve(ref: EntityRef): ResolvedEntity {
    switch (ref.kind) {
      case 'client':         return this.resolveById(ref, false);
      case 'broker':         return this.resolveById(ref, false);
      case 'empreendimento': return this.resolveEmpreendimento(ref);
      case 'fonte':          return this.resolveBySlug(ref);
      case 'regiao':         return this.resolveBySlug(ref);
    }
  }

  resolveAll(refs: EntityRef[]): ResolvedEntity[] {
    return refs.map(r => this.resolve(r));
  }

  private resolveById(ref: EntityRef, _isHub: boolean): ResolvedEntity {
    if (ref.id === undefined || ref.id === null) {
      throw new Error(`${ref.kind} ref requires id`);
    }
    const layout = ENTITY_LAYOUT[ref.kind];
    const filenamePrefix = `${layout.prefix}${ref.id}-`;
    const found = findByFilenamePrefix(this.index, layout.dir, filenamePrefix);
    if (found) return { ref, path: found, stem: stemOf(found), found: true };

    const slug = ref.display_name ? toKebabSlug(ref.display_name) : (ref.slug ?? '');
    const stem = slug ? `${layout.prefix}${ref.id}-${slug}` : `${layout.prefix}${ref.id}`;
    return { ref, path: `${layout.dir}/${stem}.md`, stem, found: false };
  }

  private resolveEmpreendimento(ref: EntityRef): ResolvedEntity {
    const layout = ENTITY_LAYOUT.empreendimento;

    if (ref.slug) {
      const stem = ref.slug.startsWith(layout.prefix) ? ref.slug : `${layout.prefix}${ref.slug}`;
      const p = `${layout.dir}/${stem}.md`;
      return { ref, path: p, stem, found: !!this.index.get(p) };
    }
    if (ref.id !== undefined && ref.id !== null) {
      const byFm = findByFrontmatterId(this.index, layout.dir, 'empreendimento_id', ref.id);
      if (byFm) return { ref, path: byFm, stem: stemOf(byFm), found: true };
      const slug = ref.display_name ? toKebabSlug(ref.display_name) : '';
      const stem = slug ? `${layout.prefix}${slug}` : `${layout.prefix}${ref.id}`;
      const p = `${layout.dir}/${stem}.md`;
      return { ref, path: p, stem, found: !!this.index.get(p) };
    }
    throw new Error(`empreendimento ref requires id or slug`);
  }

  private resolveBySlug(ref: EntityRef): ResolvedEntity {
    if (!ref.slug) throw new Error(`${ref.kind} ref requires slug`);
    const layout = ENTITY_LAYOUT[ref.kind];
    const slug = toKebabSlug(ref.slug);
    if (slug === '') throw new Error(`${ref.kind} slug '${ref.slug}' produces empty kebab-case`);
    const stem = slug;
    const p = `${layout.dir}/${stem}.md`;
    return { ref, path: p, stem, found: !!this.index.get(p) };
  }
}

function stemOf(p: string): string {
  return path.basename(p).replace(/\.md$/, '');
}

function findByFilenamePrefix(index: VaultIndex, dir: string, filenamePrefix: string): string | null {
  const dirSlash = dir.endsWith('/') ? dir : dir + '/';
  const matches = index.allEntries()
    .filter(e => e.path.startsWith(dirSlash))
    .map(e => e.path)
    .filter(p => path.basename(p).startsWith(filenamePrefix))
    .sort();
  return matches[0] ?? null;
}

function findByFrontmatterId(index: VaultIndex, dir: string, field: string, id: number): string | null {
  const dirSlash = dir.endsWith('/') ? dir : dir + '/';
  for (const e of index.allEntries()) {
    if (!e.path.startsWith(dirSlash)) continue;
    const direct = e.frontmatter?.[field];
    const external = e.frontmatter?.external_ids?.[field];
    if (matchesId(direct, id) || matchesId(external, id)) return e.path;
  }
  return null;
}

function matchesId(value: unknown, id: number): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'number') return value === id;
  if (typeof value === 'string') return value === String(id);
  return false;
}

// ─── stub creation ──────────────────────────────────────────────────────────

export interface StubInput {
  resolved: ResolvedEntity;
  vaultRoot: string;
  index: VaultIndex;
  asAgent: string;
}

/**
 * Writes a `type: hub`, `status: stub` note for missing hub references.
 * No-op when the file already exists or the entity kind is not a hub.
 * Returns true if a new stub was written.
 */
export async function ensureHubStub(input: StubInput): Promise<boolean> {
  const { resolved, vaultRoot, index, asAgent } = input;
  if (!isHubKind(resolved.ref.kind)) return false;

  const abs = safeJoin(vaultRoot, resolved.path);
  if (await statFile(abs)) return false;

  const today = new Date().toISOString().slice(0, 10);
  const display = resolved.ref.display_name ?? resolved.stem;
  const fm: Record<string, any> = {
    type: 'hub',
    owner: asAgent,
    created: today,
    updated: today,
    tags: [],
    scope: resolved.ref.kind,
    maintainer: asAgent,
    status: 'stub',
    display_name: display,
  };
  if (resolved.ref.id !== undefined && resolved.ref.id !== null) {
    fm[`${resolved.ref.kind}_id`] = resolved.ref.id;
  }
  if (resolved.ref.slug) fm.slug = resolved.ref.slug;

  const body = `# ${display}\n\n_Stub criado automaticamente por mcp-fama_obsidian. Enriquecer com conteúdo._\n`;
  await writeFileAtomic(abs, serializeFrontmatter(fm, body));
  await index.updateAfterWrite(resolved.path);
  return true;
}

// ─── wikilinks rendering ────────────────────────────────────────────────────

const VINCULOS_RE = /^Vínculos:[^\n]*\n(?:\n)?/;

/**
 * Inserts a single `Vínculos: [[a]] · [[b]] · [[c]]` line at the top of the
 * body, replacing any existing one. Idempotent.
 */
export function injectVinculosLine(body: string, stems: string[]): string {
  const stripped = body.replace(VINCULOS_RE, '');
  if (stems.length === 0) return stripped;
  const line = `Vínculos: ${stems.map(s => `[[${s}]]`).join(' · ')}\n\n`;
  return line + stripped;
}
