// src/vault/tags.ts
//
// Normalize tags to kebab-case (Obsidian-friendly). Returns the cleaned tag
// plus an optional warning when normalization changed the input — workflows
// surface warnings to callers instead of erroring, to reduce friction.

import { asciiFold } from './fs.js';

export interface TagNormalization {
  tag: string;
  original: string;
  warning: string | null;
}

/**
 * Normalize a single tag:
 *   - preserves a single leading `#` if present
 *   - preserves nesting separators (`/`)
 *   - strips trailing date suffixes (e.g. `_2026-04-01`, `-2026-04-01T...`)
 *   - converts underscores to hyphens
 *   - ASCII-folds + lowercases
 *   - replaces non `[a-z0-9/-]` runs with single `-`
 *   - collapses repeated `-` and trims edge `-`
 */
export function normalizeTag(input: string): TagNormalization {
  const original = input;
  const hashed = input.startsWith('#');
  let s = hashed ? input.slice(1) : input;

  // Strip trailing timestamps like _2026-04-01, -2026-04-01T12:34:56, etc.
  s = s.replace(/[_-]\d{4}-\d{2}-\d{2}(T[\d:.-]+)?Z?$/, '');

  // Per-segment normalization (preserve `/` for Obsidian nested tags).
  const segments = s.split('/').map(seg => {
    let t = seg.replace(/_/g, '-');
    t = asciiFold(t).toLowerCase();
    t = t.replace(/[^a-z0-9-]+/g, '-');
    t = t.replace(/-+/g, '-');
    t = t.replace(/^-+|-+$/g, '');
    return t;
  }).filter(seg => seg.length > 0);

  const cleaned = segments.join('/');
  const out = (hashed ? '#' : '') + cleaned;
  const warning = (out !== original)
    ? `tag '${original}' normalized to '${out}'`
    : null;
  return { tag: out, original, warning };
}

export interface TagBatchResult {
  tags: string[];
  warnings: string[];
}

/**
 * Normalize a list of tags. Drops empties; deduplicates while preserving
 * first-seen order. Surfaces one warning per changed tag.
 */
export function normalizeTags(input: readonly string[] | undefined | null): TagBatchResult {
  if (!input || input.length === 0) return { tags: [], warnings: [] };
  const seen = new Set<string>();
  const tags: string[] = [];
  const warnings: string[] = [];
  for (const raw of input) {
    const r = normalizeTag(raw);
    if (r.tag === '' || r.tag === '#') continue;
    if (r.warning) warnings.push(r.warning);
    if (seen.has(r.tag)) continue;
    seen.add(r.tag);
    tags.push(r.tag);
  }
  return { tags, warnings };
}
