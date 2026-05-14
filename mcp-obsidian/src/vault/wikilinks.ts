import path from 'node:path';

export const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
export const FENCED_CODE_RE = /```[\s\S]*?```/g;
export const INLINE_CODE_RE = /`[^`\r\n]*`/g;

export interface WikiIndexEntry {
  path: string;
}

export function normalizeWikiTarget(target: string): string {
  const withoutExtension = target.trim().replace(/\.md$/i, '');
  const normalized = path.posix.normalize(withoutExtension.replace(/\\/g, '/').replace(/^\/+/, ''));
  return normalized === '.' ? '' : normalized;
}

export function noteStem(rel: string): string {
  return normalizeWikiTarget(rel).replace(/\.md$/i, '');
}

export function searchableWikilinkContent(content: string): string {
  return content.replace(FENCED_CODE_RE, '').replace(INLINE_CODE_RE, '');
}

export function extractWikilinkTargets(content: string): string[] {
  const targets: string[] = [];
  for (const match of searchableWikilinkContent(content).matchAll(WIKILINK_RE)) {
    const target = normalizeWikiTarget(match[1]);
    if (target !== '') targets.push(target);
  }
  return targets;
}

export function existingWikiTargets(entries: Iterable<WikiIndexEntry>): Set<string> {
  const targets = new Set<string>();
  for (const entry of entries) {
    const stem = noteStem(entry.path);
    if (stem === '') continue;
    targets.add(stem);
    targets.add(stem.split('/').pop() ?? stem);
  }
  return targets;
}

export function wikiTargetExists(target: string, targets: Set<string>): boolean {
  const normalized = normalizeWikiTarget(target);
  const basename = normalized.split('/').pop() ?? normalized;
  return targets.has(normalized) || targets.has(basename);
}

export function hasResolvedWikilink(content: string, targets: Set<string>): boolean {
  return extractWikilinkTargets(content).some((target) => wikiTargetExists(target, targets));
}

export function unresolvedWikilinkTargets(content: string, targets: Set<string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const target of extractWikilinkTargets(content)) {
    if (seen.has(target)) continue;
    seen.add(target);
    if (!wikiTargetExists(target, targets)) missing.push(target);
  }
  return missing;
}
