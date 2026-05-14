import { McpError } from '../errors.js';
import { existingWikiTargets, extractWikilinkTargets, hasResolvedWikilink } from '../vault/wikilinks.js';
import type { ToolCtx } from './_shared.js';

const RENO_AGENT = 'reno';

function isSupportNotePath(rel: string): boolean {
  const basename = rel.replace(/\\/g, '/').split('/').pop();
  return basename === 'README.md' || basename === 'index.md';
}

function isRenoActor(actor?: string | null): boolean {
  return typeof actor === 'string' && actor.trim() === RENO_AGENT;
}

export function isRenoAuthoredSchemaV1(frontmatter: Record<string, any> | null, actor?: string | null): boolean {
  if (!frontmatter || frontmatter.schema_version !== 1) return false;
  return isRenoActor(actor) || isRenoActor(frontmatter.author_agent) || isRenoActor(frontmatter.owner);
}

export function requiresRenoResolvedWikilinkOnCreate(input: {
  rel: string;
  frontmatter: Record<string, any> | null;
  actor?: string | null;
  existing: boolean;
}): boolean {
  if (input.existing || isSupportNotePath(input.rel)) return false;
  return isRenoAuthoredSchemaV1(input.frontmatter, input.actor);
}

export function hasResolvedVaultWikilink(ctx: ToolCtx, content: string): boolean {
  return hasResolvedWikilink(content, existingWikiTargets(ctx.index.allEntries()));
}

export function assertRenoResolvedWikilinkOnCreate(ctx: ToolCtx, input: {
  rel: string;
  content: string;
  frontmatter: Record<string, any> | null;
  actor?: string | null;
  existing: boolean;
}): void {
  if (!requiresRenoResolvedWikilinkOnCreate(input)) return;
  if (hasResolvedVaultWikilink(ctx, input.content)) return;

  const wikilinks = extractWikilinkTargets(input.content);
  const detail = wikilinks.length > 0
    ? `Found wikilink target(s), but none resolves to an existing note: ${wikilinks.join(', ')}.`
    : 'No wikilink was found.';

  throw new McpError(
    'WIKILINK_TARGET_MISSING',
    `Reno-created Schema v1 note '${input.rel}' must include at least one resolved wikilink to an existing vault note. ${detail}`,
    'Use an existing link such as [[reno-hub]] or create the entity first, then link it.',
  );
}
