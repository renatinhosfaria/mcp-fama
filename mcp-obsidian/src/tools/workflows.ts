// src/tools/workflows.ts
import { z } from 'zod';
import { ToolCtx, tryToolBody, ok, ownerCheck, validateOwners, validateTimeRange, mtimeInWindow, parseRelativeOrIsoSince, enqueueWriteJob, lockPathsForWrite, assertNoLegacyNamespaceWrite, isVaultAdmin } from './_shared.js';
import { readFileAtomic, writeFileAtomic, writeFileExclusiveAtomic, safeJoin, statFile, toKebabSlug, validateJournalFilename } from '../vault/fs.js';
import { parseFrontmatter, serializeFrontmatter } from '../vault/frontmatter.js';
import { McpError, McpToolResponse } from '../errors.js';
import { setLastWriteTs } from '../last-write.js';
import { log } from '../middleware/logger.js';
import { parseLeadBody, serializeLeadBody, type LeadBody, type LeadHeaders, type LeadInteraction, serializeInteractionBlock } from '../vault/lead.js';
import { parseBrokerBody, serializeBrokerBody, type BrokerBody, type BrokerHeaders, type BrokerInteraction, serializeInteractionBlock as serializeBrokerInteraction } from '../vault/broker.js';
import { parseRegressaoBody } from '../vault/regressao.js';
import { parseFinancialBody, serializeFinancialBody, extractFirstLine, type FinancialSections } from '../vault/financial.js';
import { EntityResolver, ensureHubStub, injectVinculosLine, isHubKind, type EntityRef, type EntityKind, type ResolvedEntity, ENTITY_LAYOUT } from '../vault/entity-resolver.js';
import { normalizeTags } from '../vault/tags.js';
import { config } from '../config.js';
import { computeTrustLevel, passesMinTrust } from '../vault/trust.js';
import { normalizeDateInput } from '../vault/schema-v1.js';
import { assertRenoResolvedWikilinkOnCreate, isRenoAuthoredSchemaV1 } from './wikilink-policy.js';
import { existingWikiTargets, extractWikilinkTargets, hasResolvedWikilink, wikiTargetExists } from '../vault/wikilinks.js';
import {
  agentTerritory,
  authoredBy,
  isAgentDecision,
  isAgentEntityContribution,
  isAgentHub,
  isAgentJournal,
  isAgentProfile,
  isAgentProject,
  isAgentRunbook,
  isAgentSharedContext,
  sortNewest,
  summarizeEntry,
} from '../vault/agent-territory.js';
import { scanSensitiveIndex } from '../vault/sensitive-scan.js';

function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const VALIDATION_CATEGORIES = [
  'schema_error',
  'ownership_violation',
  'legacy_namespace',
  'broken_link',
  'wikilink_required',
  'trust_gap',
  'index_policy_gap',
  'routing_gap',
  'frontmatter_missing',
] as const;

type ValidationCategory = typeof VALIDATION_CATEGORIES[number];

interface ValidationFinding {
  category: ValidationCategory;
  path: string;
  message: string;
}

interface NoteValidationDiagnostics {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  frontmatter: Record<string, any> | null;
}

function normalizeRelPath(rel: string): string {
  const parts: string[] = [];
  for (const part of rel.replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function isLegacyNamespace(rel: string): boolean {
  return rel === '_agents' || rel.startsWith('_agents/');
}

function isKnownV1DestinationPath(rel: string): boolean {
  if (isSupportNotePath(rel)) return false;
  return /^_journal\/[^/]+\/[^/]+\.md$/.test(rel)
    || /^_entities\/[^/]+\.md$/.test(rel)
    || /^_decisions\/[^/]+\.md$/.test(rel)
    || /^_hubs\/[^/]+\.md$/.test(rel)
    || /^_runbooks\/[^/]+\.md$/.test(rel)
    || /^_meta\/.+\.md$/.test(rel)
    || /^_shared\/goals\/[^/]+\/[^/]+\.md$/.test(rel)
    || /^_shared\/results\/[^/]+\/[^/]+\.md$/.test(rel);
}

function isSupportNotePath(rel: string): boolean {
  const basename = rel.split('/').pop();
  return basename === 'README.md' || basename === 'index.md';
}

function isRoutedV1Path(rel: string, fm: Record<string, any>): boolean {
  switch (fm.type) {
    case 'journal':
    case 'interaction':
      return rel.startsWith('_journal/');
    case 'entity':
      return rel.startsWith('_entities/');
    case 'decision':
      return rel.startsWith('_decisions/');
    case 'hub':
      return rel.startsWith('_hubs/');
    case 'runbook':
      return rel.startsWith('_runbooks/');
    case 'concept':
    case 'reference':
    case 'project':
      return rel.startsWith('_meta/');
    case 'goal':
      return rel.startsWith('_shared/goals/');
    case 'result':
      return rel.startsWith('_shared/results/');
    default:
      return false;
  }
}

function validationFinding(category: ValidationCategory, path: string, message: string): ValidationFinding {
  return { category, path, message };
}

function validationErrorMessage(err: unknown): string {
  if (err instanceof McpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function hasAuthorAgent(fm: Record<string, any>): boolean {
  return typeof fm.author_agent === 'string' && fm.author_agent.trim().length > 0;
}

function actorForOwnership(fm: Record<string, any>): string | null {
  if (hasAuthorAgent(fm)) return fm.author_agent.trim();
  if (typeof fm.owner === 'string' && fm.owner.trim().length > 0) return fm.owner.trim();
  return null;
}

async function ownershipFinding(ctx: ToolCtx, rel: string, fm: Record<string, any>): Promise<ValidationFinding | null> {
  const actor = actorForOwnership(fm);
  if (!actor || actor === 'vault_admin') return null;
  const access = await ctx.index.getOwnershipResolver().resolveAccess(rel, actor);
  const owner = access.owner;
  if (owner === null || access.allowed) return null;
  return validationFinding(
    'ownership_violation',
    rel,
    `Path is owned by '${owner}', but provenance points to '${actor}'.`,
  );
}

async function validateNoteContent(
  ctx: ToolCtx,
  rel: string,
  content: string,
  targets = existingWikiTargets(ctx.index.allEntries()),
): Promise<NoteValidationDiagnostics> {
  const normalized = normalizeRelPath(rel);
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];

  if (isLegacyNamespace(normalized)) {
    errors.push(validationFinding(
      'legacy_namespace',
      normalized,
      'Legacy _agents namespace is read-only for Schema v1 writes.',
    ));
  }

  let frontmatter: Record<string, any> | null = null;
  try {
    frontmatter = parseFrontmatter(content).frontmatter;
  } catch (err) {
    errors.push(validationFinding('schema_error', normalized, validationErrorMessage(err)));
    return { errors, warnings, frontmatter: null };
  }

  if (!frontmatter) {
    errors.push(validationFinding('frontmatter_missing', normalized, 'Note has no YAML frontmatter.'));
    return { errors, warnings, frontmatter: null };
  }

  if (isKnownV1DestinationPath(normalized) && frontmatter.schema_version !== 1) {
    errors.push(validationFinding(
      'schema_error',
      normalized,
      'schema_version: 1 is required for routed Schema v1 destinations.',
    ));
  }

  if (frontmatter.schema_version === 1 && !isRoutedV1Path(normalized, frontmatter)) {
    errors.push(validationFinding(
      'routing_gap',
      normalized,
      `Schema v1 type '${frontmatter.type}' is not stored under its routed destination.`,
    ));
  }

  if (frontmatter.source === 'agent-generated' && !hasAuthorAgent(frontmatter)) {
    warnings.push(validationFinding(
      'trust_gap',
      normalized,
      'agent-generated note is missing author_agent provenance.',
    ));
  }

  const ownerIssue = await ownershipFinding(ctx, normalized, frontmatter);
  if (ownerIssue) errors.push(ownerIssue);

  if (isRenoAuthoredSchemaV1(frontmatter, actorForOwnership(frontmatter)) && !isSupportNotePath(normalized) && !hasResolvedWikilink(content, targets)) {
    errors.push(validationFinding(
      'wikilink_required',
      normalized,
      'Reno Schema v1 notes must include at least one resolved wikilink to an existing vault note.',
    ));
  }

  return { errors, warnings, frontmatter };
}

function recommendedValidationTool(rel: string, frontmatter: Record<string, any> | null): string | undefined {
  if (!isLegacyNamespace(rel)) return undefined;
  if (/^_agents\/[^/]+\/journal\//.test(rel)) return 'create_journal_event';
  if (/^_agents\/[^/]+\/decisions(?:\.md|\/)/.test(rel)) return 'record_decision';
  if (/^_agents\/[^/]+\/lead\//.test(rel)) return 'upsert_lead_timeline';
  if (/^_agents\/[^/]+\/broker\//.test(rel)) return 'upsert_broker_profile';
  if (frontmatter?.type === 'entity' || frontmatter?.type === 'entity-profile') return 'create_or_update_entity';
  if (!frontmatter) return 'create_journal_event';
  return undefined;
}

function validationCounts(): Record<ValidationCategory, number> {
  return Object.fromEntries(VALIDATION_CATEGORIES.map((category) => [category, 0])) as Record<ValidationCategory, number>;
}

function brokenLinkFindings(rel: string, content: string, targets: Set<string>): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();
  for (const target of extractWikilinkTargets(content)) {
    if (seen.has(target)) continue;
    seen.add(target);
    if (isLegacyNamespace(normalizeRelPath(target))) {
      findings.push(validationFinding(
        'broken_link',
        rel,
        `Legacy canonical wikilink target is not allowed: ${target}`,
      ));
      continue;
    }
    if (wikiTargetExists(target, targets)) continue;
    findings.push(validationFinding('broken_link', rel, `Wikilink target not found: ${target}`));
  }
  return findings;
}

function summarizeFrontmatter(fm: Record<string, any>): Record<string, any> {
  const keys = [
    'schema_version',
    'type',
    'status',
    'source',
    'tags',
    'author_agent',
    'owner',
    'name',
    'entity_type',
    'subtype',
    'external_ids',
    'aliases',
    'verified_by',
    'verified_at',
  ];
  const out: Record<string, any> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(fm, key)) out[key] = fm[key];
  }
  return out;
}

// ─── entity-ref helpers (auto-wikilinks) ────────────────────────────────────

interface EntityRefInputs {
  client_id?: number | null;
  broker_id?: number | null;
  empreendimento_id?: number | null;
  empreendimento_slug?: string | null;
  fonte?: string | null;
  regiao?: string | null;
  display_names?: {
    client?: string;
    broker?: string;
    empreendimento?: string;
  };
}

function collectEntityRefs(input: EntityRefInputs, prior: Record<string, any> | null): EntityRef[] {
  const refs: EntityRef[] = [];
  const pickId = (key: string): number | undefined => {
    const v = (input as any)[key];
    if (v !== undefined && v !== null) return v;
    if (prior?.[key] !== undefined && prior?.[key] !== null) return Number(prior[key]);
    return undefined;
  };
  const pickSlug = (key: string): string | undefined => {
    const v = (input as any)[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof prior?.[key] === 'string' && prior[key].length > 0) return prior[key];
    return undefined;
  };

  const clientId = pickId('client_id');
  if (clientId !== undefined) refs.push({ kind: 'client', id: clientId, display_name: input.display_names?.client });

  const brokerId = pickId('broker_id');
  if (brokerId !== undefined) refs.push({ kind: 'broker', id: brokerId, display_name: input.display_names?.broker });

  const empId = pickId('empreendimento_id');
  const empSlug = pickSlug('empreendimento_slug');
  if (empId !== undefined || empSlug !== undefined) {
    refs.push({
      kind: 'empreendimento',
      id: empId,
      slug: empSlug,
      display_name: input.display_names?.empreendimento,
    });
  }

  const fonte = pickSlug('fonte');
  if (fonte !== undefined) refs.push({ kind: 'fonte', slug: fonte });

  const regiao = pickSlug('regiao');
  if (regiao !== undefined) refs.push({ kind: 'regiao', slug: regiao });

  return refs;
}

interface ResolveOutcome {
  resolved: ResolvedEntity[];
  stems: string[];
  stubs_created: string[];
}

async function resolveAndEnsureStubs(
  ctx: ToolCtx,
  refs: EntityRef[],
  asAgent: string,
): Promise<ResolveOutcome> {
  const resolver = new EntityResolver(ctx.index);
  const resolved = resolver.resolveAll(refs);
  const stubs_created: string[] = [];
  for (const r of resolved) {
    if (!r.found && isHubKind(r.ref.kind)) {
      const created = await ensureHubStub({
        resolved: r,
        vaultRoot: ctx.vaultRoot,
        index: ctx.index,
        asAgent,
      });
      if (created) {
        stubs_created.push(r.path);
        await enqueueWriteJob(ctx, {
          path: r.path,
          message: `[mcp] auto-stub: ${r.path}`,
          as_agent: asAgent,
          tool: 'auto_stub',
        });
      }
    }
  }
  return { resolved, stems: resolved.map(r => r.stem), stubs_created };
}

function applyEntityRefsToFrontmatter(
  fm: Record<string, any>,
  input: EntityRefInputs,
  prior: Record<string, any> | null,
  stems: string[],
): void {
  const carryNumber = (key: string): void => {
    const v = (input as any)[key];
    if (v !== undefined && v !== null) fm[key] = v;
    else if (prior?.[key] !== undefined && prior[key] !== null) fm[key] = prior[key];
  };
  const carryString = (key: string): void => {
    const v = (input as any)[key];
    if (typeof v === 'string' && v.length > 0) fm[key] = v;
    else if (typeof prior?.[key] === 'string' && prior[key].length > 0) fm[key] = prior[key];
  };
  carryNumber('client_id');
  carryNumber('broker_id');
  carryNumber('empreendimento_id');
  carryString('empreendimento_slug');
  carryString('fonte');
  carryString('regiao');
  if (stems.length > 0) fm.wikilinks = stems;
  else if (prior?.wikilinks) delete fm.wikilinks;
}

// ─── create_journal_event / create_journal_entry ─────────────────────────────

export const CreateJournalEventSchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  event_date: z.string().optional(),
  occurred_at: z.string().optional(),
  channel: z.string().min(1).optional(),
  participants: z.array(z.string()).optional().default([]),
  mentions_entity: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional().default([]),
  source: z.enum(['human-curated', 'agent-generated', 'imported']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  external_ids: z.record(z.string()).optional(),
});

export const CreateJournalEntrySchema = CreateJournalEventSchema;

function eventDateFromInput(eventDate?: string, occurredAt?: string): { eventDate: string; occurredAt?: string } {
  if (occurredAt) {
    const normalized = normalizeDateInput(occurredAt);
    if (!normalized.timestamp) throw new McpError('INVALID_SCHEMA_V1', `occurred_at must be ISO-8601 with timezone: ${occurredAt}`);
    return {
      eventDate: eventDate ? normalizeDateInput(eventDate).date : normalized.date,
      occurredAt: normalized.timestamp,
    };
  }
  if (eventDate) {
    return { eventDate: normalizeDateInput(eventDate).date };
  }
  return { eventDate: today() };
}

export async function createJournalEvent(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = CreateJournalEventSchema.parse(args);
    const dates = eventDateFromInput(a.event_date, a.occurred_at);
    const slug = toKebabSlug(a.title);
    if (slug === '') throw new McpError('INVALID_FILENAME', `title '${a.title}' produces empty slug`);
    const writeDate = today();
    const filename = `${dates.eventDate}-${slug}.md`;
    validateJournalFilename(filename);
    const rel = `_journal/${a.agent}/${filename}`;

    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    await lockPathsForWrite(ctx, [rel]);
    const existing = await statFile(safe);
    if (existing) throw new McpError('JOURNAL_IMMUTABLE', `Journal entry already exists: ${rel}. Journals are append-only; use append_to_note instead.`);

    const isInteraction = Boolean(a.channel && a.participants.length > 0);
    const fm: Record<string, any> = {
      schema_version: 1,
      type: isInteraction ? 'interaction' : 'journal',
      status: 'active',
      created: writeDate,
      updated: writeDate,
      source: a.source ?? config.defaultAgentSource,
      author_agent: a.agent,
      tags: a.tags,
      title: a.title,
      event_date: dates.eventDate,
    };
    if (dates.occurredAt) fm.occurred_at = dates.occurredAt;
    if (a.channel) fm.channel = a.channel;
    if (a.participants.length > 0) fm.participants = a.participants;
    if (a.mentions_entity) fm.mentions_entity = a.mentions_entity;
    if (a.related) fm.related = a.related;
    if (a.confidence !== undefined) fm.confidence = a.confidence;
    if (a.external_ids) fm.external_ids = a.external_ids;

    const assembled = serializeFrontmatter(fm, a.content);
    parseFrontmatter(assembled);
    assertRenoResolvedWikilinkOnCreate(ctx, {
      rel,
      content: assembled,
      frontmatter: fm,
      actor: a.agent,
      existing: false,
    });
    await writeFileExclusiveAtomic(
      safe,
      assembled,
      new McpError('JOURNAL_IMMUTABLE', `Journal entry already exists: ${rel}. Journals are append-only; use append_to_note instead.`),
    );
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'create_journal_event', as_agent: a.agent, path: rel, action: 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] create_journal_event: ${rel}`, as_agent: a.agent, tool: 'create_journal_event' });
    return { path: rel, created: true };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Created ${(r.value as any).path}`);
}

export async function createJournalEntry(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  if (config.legacyToolMode === 'error') {
    return new McpError(
      'DEPRECATED_TOOL',
      'create_journal_entry is deprecated.',
      'Use create_journal_event.',
    ).toMcpResponse();
  }
  const r = await createJournalEvent(args, ctx);
  if (r.isError) return r;
  const path = (r.structuredContent as any).path;
  return ok({
    ...(r.structuredContent as any),
    deprecated: true,
    legacy_tool: 'create_journal_entry',
    redirected_to: 'create_journal_event',
    legacy_tool_mode: config.legacyToolMode,
    new_path: path,
  }, `Created ${path} via create_journal_event`);
}

// ─── record_decision / append_decision ───────────────────────────────────────

const DecisionLinksSchema = z.array(z.string().min(1)).optional().default([]);

export const RecordDecisionSchema = z.object({
  as_agent: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  source: z.enum(['human-curated', 'agent-generated', 'imported']).optional(),
  decided_by: DecisionLinksSchema,
  supersedes: DecisionLinksSchema,
  superseded_by: DecisionLinksSchema,
  mentions_entity: z.array(z.string()).optional().default([]),
  implements: z.array(z.string()).optional().default([]),
  related: z.array(z.string()).optional().default([]),
});

export async function recordDecision(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = RecordDecisionSchema.parse(args);
    const slug = toKebabSlug(a.title);
    if (slug === '') throw new McpError('INVALID_FILENAME', `title '${a.title}' produces empty slug`);
    const writeDate = today();
    const filename = a.as_agent === 'reno'
      ? `${writeDate}-reno-${slug}.md`
      : `${writeDate}-${slug}.md`;
    validateJournalFilename(filename);
    const rel = `_decisions/${filename}`;

    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    await lockPathsForWrite(ctx, [rel]);
    const existing = await statFile(safe);
    if (existing) throw new McpError('IMMUTABLE_TARGET', `Decision already exists: ${rel}`);

    const fm: Record<string, any> = {
      schema_version: 1,
      type: 'decision',
      status: 'active',
      created: writeDate,
      updated: writeDate,
      source: a.source ?? config.defaultAgentSource,
      tags: a.tags,
      author_agent: a.as_agent,
      title: a.title,
      decided_by: a.decided_by,
      supersedes: a.supersedes,
      superseded_by: a.superseded_by,
      mentions_entity: a.mentions_entity,
      implements: a.implements,
      related: a.related,
    };
    const body = `# ${a.title}\n\n## Rationale\n\n${a.rationale}\n`;
    const assembled = serializeFrontmatter(fm, body);
    parseFrontmatter(assembled);
    assertRenoResolvedWikilinkOnCreate(ctx, {
      rel,
      content: assembled,
      frontmatter: fm,
      actor: a.as_agent,
      existing: Boolean(existing),
    });
    await writeFileExclusiveAtomic(
      safe,
      assembled,
      new McpError('IMMUTABLE_TARGET', `Decision already exists: ${rel}`),
    );
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'record_decision', as_agent: a.as_agent, path: rel, action: 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] record_decision: ${rel}`, as_agent: a.as_agent, tool: 'record_decision' });
    return { path: rel, created: true };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Created ${(r.value as any).path}`);
}

export const AppendDecisionSchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
});

export async function appendDecision(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  void args;
  void ctx;
  return new McpError(
    'DEPRECATED_TOOL',
    'append_decision is deprecated; use record_decision to create a write-once decision note in _decisions/.',
    'Use record_decision to create a write-once Schema v1 decision note in _decisions/.',
  ).toMcpResponse();
}

// ─── update_agent_profile ────────────────────────────────────────────────────

export const UpdateAgentProfileSchema = z.object({
  agent: z.string().min(1),
  content: z.string(),
});

export async function updateAgentProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpdateAgentProfileSchema.parse(args);
    const territory = agentTerritory(a.agent);
    const runbookProfile = territory.profile_candidates[0];
    const sharedProfile = territory.profile_candidates[1];
    const rel = ctx.index.get(runbookProfile) ? runbookProfile : sharedProfile;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    const parsed = existing ? parseFrontmatter((await readFileAtomic(safe)).content) : { frontmatter: null };
    const fm: Record<string, any> = {
      ...(parsed.frontmatter ?? {
        type: 'agent-profile',
        owner: a.agent,
        created: today(),
        tags: [],
      }),
      updated: today(),
    };
    if (rel.startsWith('_runbooks/')) {
      fm.schema_version = 1;
      fm.type = 'runbook';
      fm.status = fm.status ?? 'active';
      fm.source = fm.source ?? config.defaultAgentSource;
      fm.author_agent = a.agent;
      fm.title = fm.title ?? `${a.agent} Profile`;
      fm.procedure_owner = fm.procedure_owner ?? a.agent;
      fm.trigger = fm.trigger ?? 'context-read';
    }
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'update_agent_profile', as_agent: a.agent, path: rel, action: 'update', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] update_agent_profile: ${rel}`, as_agent: a.agent, tool: 'update_agent_profile' });
    return { path: rel };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Updated ${(r.value as any).path}`);
}

// ─── upsert_goal + upsert_result ─────────────────────────────────────────────

const periodRe = /^\d{4}-\d{2}$/;

export const UpsertGoalSchema = z.object({
  agent: z.string().min(1),
  period: z.string().regex(periodRe, 'period must be YYYY-MM'),
  content: z.string(),
});

async function upsertPeriodic(kind: 'goal' | 'result', args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertGoalSchema.parse(args);
    const folder = kind === 'goal' ? 'goals' : 'results';
    const rel = `_shared/${folder}/${a.period}/${a.agent}.md`;
    await ownerCheck(ctx, rel, a.agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    const priorFm = existing ? parseFrontmatter((await readFileAtomic(safe)).content).frontmatter : null;
    const fm = {
      type: kind, owner: a.agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: priorFm?.tags ?? [],
      period: a.period,
    };
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: `upsert_${kind}`, as_agent: a.agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_${kind}: ${rel}`, as_agent: a.agent, tool: `upsert_${kind}` });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const upsertGoal = (args: unknown, ctx: ToolCtx) => upsertPeriodic('goal', args, ctx);
export const upsertResult = (args: unknown, ctx: ToolCtx) => upsertPeriodic('result', args, ctx);

// ─── read_agent_context ──────────────────────────────────────────────────────

export const ReadAgentContextSchema = z.object({
  agent: z.string().min(1),
  n_decisions: z.number().int().positive().optional().default(5),
  n_journals: z.number().int().positive().optional().default(5),
});

function toSummary(e: any) {
  return { path: e.path, type: e.type, owner: e.owner, updated: e.updated, tags: e.tags, mtime: new Date(e.mtimeMs).toISOString() };
}

async function readAgentContextLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadAgentContextSchema.parse(args);
    const profileEntry = ctx.index.get(`_agents/${a.agent}/profile.md`);
    const profile = profileEntry ? { ...toSummary(profileEntry), frontmatter: profileEntry.frontmatter } : null;

    const decisionsEntry = ctx.index.get(`_agents/${a.agent}/decisions.md`);
    let decisions: any[] = [];
    if (decisionsEntry) {
      const { content } = await readFileAtomic(safeJoin(ctx.vaultRoot, decisionsEntry.path));
      const body = parseFrontmatter(content).body;
      const blocks = body.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(s => s.trim().startsWith('## '));
      decisions = blocks.slice(0, a.n_decisions).map(b => {
        const firstLine = b.split('\n', 1)[0];
        const m = firstLine.match(/^## (\d{4}-\d{2}-\d{2}) — (.+)$/);
        return { date: m?.[1] ?? null, title: m?.[2] ?? firstLine.replace(/^##\s*/, ''), body: b };
      });
    }

    const journals = ctx.index.byOwner(a.agent)
      .filter(e => e.type === 'journal')
      .sort((x, y) => y.mtimeMs - x.mtimeMs)
      .slice(0, a.n_journals)
      .map(toSummary);
    const goals = ctx.index.byOwner(a.agent).filter(e => e.type === 'goal').map(toSummary);
    const results = ctx.index.byOwner(a.agent).filter(e => e.type === 'result').map(toSummary);

    return { profile, decisions, journals, goals, results };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `Context for ${(args as any).agent}: ${sc.decisions.length} decisions, ${sc.journals.length} journals, ${sc.goals.length} goals, ${sc.results.length} results`);
}
// ─── get_agent_delta ─────────────────────────────────────────────────────────

export async function readAgentContext(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadAgentContextSchema.parse(args);
    const territory = agentTerritory(a.agent);
    const entries = ctx.index.allEntries();

    const hubEntry = entries.find(e => isAgentHub(e, a.agent)) ?? null;
    const hub = hubEntry ? { ...toSummary(hubEntry), frontmatter: hubEntry.frontmatter } : null;

    const profileEntry = territory.profile_candidates
      .map(candidate => ctx.index.get(candidate))
      .find(Boolean) ?? null;
    const profile = profileEntry ? { ...toSummary(profileEntry), frontmatter: profileEntry.frontmatter } : null;

    const v1Decisions = sortNewest(entries.filter(e => isAgentDecision(e, a.agent)))
      .slice(0, a.n_decisions)
      .map(e => ({ ...toSummary(e), frontmatter: e.frontmatter }));
    const legacyDecisionsEntry = ctx.index.get(territory.legacy_decisions);
    const legacyDecisions: any[] = [];
    if (legacyDecisionsEntry && v1Decisions.length < a.n_decisions) {
      const { content } = await readFileAtomic(safeJoin(ctx.vaultRoot, legacyDecisionsEntry.path));
      const body = parseFrontmatter(content).body;
      const blocks = body.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(s => s.trim().startsWith('## '));
      for (const b of blocks.slice(0, a.n_decisions - v1Decisions.length)) {
        const firstLine = b.split('\n', 1)[0];
        const m = firstLine.match(/^## (\d{4}-\d{2}-\d{2}) .+ (.+)$/);
        legacyDecisions.push({
          path: legacyDecisionsEntry.path,
          legacy: true,
          date: m?.[1] ?? null,
          title: m?.[2] ?? firstLine.replace(/^##\s*/, ''),
          body: b,
        });
      }
    }

    const decisions = [...v1Decisions, ...legacyDecisions];
    const journalEntries = [];
    for (const e of sortNewest(entries.filter(e => isAgentJournal(e, a.agent)))) {
      if (!await statFile(safeJoin(ctx.vaultRoot, e.path))) continue;
      journalEntries.push(e);
      if (journalEntries.length >= a.n_journals) break;
    }
    const journals = journalEntries.map(e => ({ ...toSummary(e), frontmatter: e.frontmatter }));
    const runbooks = sortNewest(entries.filter(e => isAgentRunbook(e, a.agent)))
      .map(e => ({ ...toSummary(e), frontmatter: e.frontmatter }));
    const projects = sortNewest(entries.filter(e => isAgentProject(e, a.agent))).map(toSummary);
    const shared_context = sortNewest(entries.filter(e => isAgentSharedContext(e, a.agent))).map(toSummary);
    const goals = sortNewest(ctx.index.byOwner(a.agent).filter(e => e.type === 'goal')).map(toSummary);
    const results = sortNewest(ctx.index.byOwner(a.agent).filter(e => e.type === 'result')).map(toSummary);
    const warnings = [
      ...(hub ? [] : [{ code: 'MISSING_HUB', path: territory.hub }]),
      ...(profile ? [] : [{ code: 'MISSING_PROFILE', paths: territory.profile_candidates }]),
    ];

    return {
      profile,
      decisions,
      journals,
      goals,
      results,
      hub,
      runbooks,
      projects,
      shared_context,
      territory: {
        hub: territory.hub,
        profile_candidates: territory.profile_candidates,
        decisions_glob: territory.decisions_glob,
        journal_prefix: territory.journal_prefix,
        runbook_prefix: territory.runbook_prefix,
        project_prefix: territory.project_prefix,
        shared_context_prefix: territory.shared_context_prefix,
      },
      warnings,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `Context for ${(args as any).agent}: ${sc.decisions.length} decisions, ${sc.journals.length} journals, ${sc.goals.length} goals, ${sc.results.length} results`);
}

export const GetAgentDeltaSchema = z.object({
  agent: z.string().min(1),
  since: z.string().datetime(),
  types: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

export interface DeltaGroups {
  decisions: any[]; journals: any[]; goals: any[]; results: any[];
  shared_contexts: any[]; entity_profiles: any[]; other: any[];
}

function bucket(pth: string): keyof DeltaGroups {
  if (/^_decisions\/[^/]+\.md$/.test(pth)) return 'decisions';
  if (/^_journal\/[^/]+\//.test(pth)) return 'journals';
  if (/^_agents\/[^/]+\/decisions\.md$/.test(pth)) return 'decisions';
  if (/^_agents\/[^/]+\/journal\//.test(pth)) return 'journals';
  if (/^_shared\/goals\//.test(pth)) return 'goals';
  if (/^_shared\/results\//.test(pth)) return 'results';
  if (/^_shared\/context\//.test(pth)) return 'shared_contexts';
  if (/^_entities\/[^/]+\.md$/.test(pth)) return 'entity_profiles';
  if (/^_agents\/[^/]+\/(?!README\.md|profile\.md|decisions\.md|journal\/)[^/]+\/[^/]+\.md$/.test(pth)) return 'entity_profiles';
  return 'other';
}

export async function computeAgentDelta(
  ctx: ToolCtx,
  agent: string,
  sinceMs: number,
  types: string[] | undefined,
  includeContent: boolean,
): Promise<DeltaGroups> {
  const groups: DeltaGroups = { decisions: [], journals: [], goals: [], results: [], shared_contexts: [], entity_profiles: [], other: [] };
  const typeFilter = types ? new Set(types) : null;

  const entries = new Map<string, any>();
  for (const e of ctx.index.byOwner(agent)) entries.set(e.path, e);
  for (const e of ctx.index.allEntries()) {
    if (authoredBy(e, agent) || isAgentEntityContribution(e, agent)) entries.set(e.path, e);
  }

  for (const e of entries.values()) {
    if (e.mtimeMs <= sinceMs) continue;
    if (typeFilter && (!e.type || !typeFilter.has(e.type))) continue;
    let content: string;
    try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
    catch { continue; }
    const item: any = {
      path: e.path, updated: e.updated, mtime: new Date(e.mtimeMs).toISOString(),
      frontmatter: e.frontmatter,
      preview: content.slice(0, 500),
    };
    if (includeContent) item.content = content;
    groups[bucket(e.path)].push(item);
  }
  return groups;
}

export async function getAgentDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetAgentDeltaSchema.parse(args);
    const sinceMs = Date.parse(a.since);
    if (isNaN(sinceMs)) throw new McpError('VAULT_IO_ERROR', 'since must be ISO-8601');
    return await computeAgentDelta(ctx, a.agent, sinceMs, a.types, a.include_content);
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  const total = Object.values(sc).reduce<number>((acc, v: any) => acc + (v as any[]).length, 0);
  return ok(sc, `Delta: ${total} entries`);
}

// ─── get_shared_context_delta ────────────────────────────────────────────────

export const GetSharedContextDeltaSchema = z.object({
  since: z.string(),
  topics: z.array(z.string()).optional(),
  owners: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

function topicFromSharedContextPath(rel: string): string | null {
  // _shared/context/<topic>/<agent>/<slug>.md
  const parts = rel.split('/');
  if (parts.length < 5) return null;
  if (parts[0] !== '_shared' || parts[1] !== 'context') return null;
  return parts[2];
}

export async function getSharedContextDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetSharedContextDeltaSchema.parse(args);
    // validateTimeRange throws INVALID_TIME_RANGE on malformed since
    const window = validateTimeRange(a.since, undefined);
    const sinceMs = window.sinceMs!;
    const ownerList = await validateOwners(ctx, a.owners);
    const topicFilter = a.topics ? new Set(a.topics) : null;
    const ownerFilter = ownerList ? new Set(ownerList) : null;

    const byTopic: Record<string, any[]> = {};
    let total = 0;

    for (const e of ctx.index.byType('shared-context')) {
      if (e.mtimeMs <= sinceMs) continue;
      const topic = topicFromSharedContextPath(e.path);
      if (!topic) continue;
      if (topicFilter && !topicFilter.has(topic)) continue;
      if (ownerFilter && (!e.owner || !ownerFilter.has(e.owner))) continue;

      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
      catch { continue; }

      const item: any = {
        path: e.path,
        owner: e.owner,
        updated: e.updated,
        mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;

      if (!byTopic[topic]) byTopic[topic] = [];
      byTopic[topic].push(item);
      total++;
    }
    return { by_topic: byTopic, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Shared context delta: ${v.total} entries across ${Object.keys(v.by_topic).length} topics`);
}

// ─── get_training_target_delta ───────────────────────────────────────────────

export const GetTrainingTargetDeltaSchema = z.object({
  target_agent: z.string().min(1),
  since: z.string(),
  topics: z.array(z.string()).optional(),
  include_content: z.boolean().optional().default(false),
});

export async function getTrainingTargetDelta(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetTrainingTargetDeltaSchema.parse(args);
    const window = validateTimeRange(a.since, undefined);
    const sinceMs = window.sinceMs!;
    const topicFilter = a.topics ? new Set(a.topics) : null;
    const targetTag = `#alvo-${a.target_agent}`;

    // 1) target_agent_delta (unfiltered by topics)
    const target_agent_delta = await computeAgentDelta(ctx, a.target_agent, sinceMs, undefined, a.include_content);

    // 2) shared_about_target: shared-context from OTHER owners mentioning target via #alvo-<target> tag OR body Agente alvo
    const sharedAboutMap = new Map<string, any>();
    for (const e of ctx.index.byType('shared-context')) {
      if (e.mtimeMs <= sinceMs) continue;
      if (e.owner === a.target_agent) continue; // self-exclusion per spec
      const topic = topicFromSharedContextPath(e.path);
      if (!topic) continue;
      if (topicFilter && !topicFilter.has(topic)) continue;

      const tagMatch = Array.isArray(e.tags) && e.tags.includes(targetTag);
      let bodyMatch = false;
      let content: string | null = null;
      if (!tagMatch && topic === 'regressoes') {
        // Parse body for `## Agente alvo` section
        try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
        catch { continue; }
        const parsed = parseFrontmatter(content);
        const reg = parseRegressaoBody(parsed.body);
        if (reg.agente_alvo === a.target_agent) bodyMatch = true;
      }
      if (!tagMatch && !bodyMatch) continue;

      if (content === null) {
        try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
        catch { continue; }
      }

      const item: any = {
        path: e.path,
        owner: e.owner,
        topic,
        mtime: new Date(e.mtimeMs).toISOString(),
        frontmatter: e.frontmatter,
        preview: content.slice(0, 500),
      };
      if (a.include_content) item.content = content;
      sharedAboutMap.set(e.path, item);
    }
    const shared_about_target = [...sharedAboutMap.values()];

    // 3) regressions: subset of shared_about_target where topic === 'regressoes', with body fields projected
    const regressions: any[] = [];
    for (const item of shared_about_target) {
      if (item.topic !== 'regressoes') continue;
      let fullContent = item.content;
      if (!fullContent) {
        try { ({ content: fullContent } = await readFileAtomic(safeJoin(ctx.vaultRoot, item.path))); }
        catch { continue; }
      }
      const parsed = parseFrontmatter(fullContent);
      const reg = parseRegressaoBody(parsed.body);
      regressions.push({
        ...item,
        status: reg.status,
        severidade: reg.severidade,
        categoria: reg.categoria,
      });
    }

    const target_agent_delta_total = Object.values(target_agent_delta).reduce<number>((acc, v: any) => acc + v.length, 0);
    const total = target_agent_delta_total + shared_about_target.length + regressions.length;

    return { target_agent_delta, shared_about_target, regressions, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Training-target delta for '${(args as any).target_agent}': ${v.total} entries (agent+shared+regressions)`);
}

// ─── upsert_shared_context ───────────────────────────────────────────────────

const KEBAB_SEG = /^[a-z0-9][a-z0-9-]*$/;

export const UpsertSharedContextSchema = z.object({
  as_agent: z.string().min(1),
  topic: z.string().regex(KEBAB_SEG, 'topic must be kebab single-segment'),
  slug: z.string().regex(KEBAB_SEG, 'slug must be kebab single-segment'),
  title: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

export async function upsertSharedContext(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertSharedContextSchema.parse(args);
    const rel = `_shared/context/${a.topic}/${a.as_agent}/${a.slug}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    const priorFm = existing ? parseFrontmatter((await readFileAtomic(safe)).content).frontmatter : null;
    const fm = {
      type: 'shared-context', owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags,
      topic: a.topic,
      title: a.title,
    };
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, a.content));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_shared_context', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_shared_context: ${rel}`, as_agent: a.as_agent, tool: 'upsert_shared_context' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── create_or_update_entity / upsert_entity_profile ─────────────────────────

const EntityStatusSchema = z.enum(['draft', 'active', 'superseded', 'archived']);
const EntitySourceSchema = z.enum(['human-curated', 'agent-generated', 'imported']);
const EntityLinksSchema = z.array(z.string().min(1));
const ProtectedEntityFieldSchema = z.union([z.string(), z.array(z.string()), z.null()]);

export const CreateOrUpdateEntitySchema = z.object({
  as_agent: z.string().min(1),
  name: z.string().min(1),
  entity_type: z.string().regex(KEBAB_SEG, 'entity_type must be kebab single-segment'),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: EntityStatusSchema.optional(),
  source: EntitySourceSchema.optional(),
  aliases: EntityLinksSchema.optional(),
  external_ids: z.record(z.string()).optional(),
  mentions_entity: EntityLinksSchema.optional(),
  related: EntityLinksSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  verified_by: ProtectedEntityFieldSchema.optional(),
  verified_at: ProtectedEntityFieldSchema.optional(),
  superseded_by: ProtectedEntityFieldSchema.optional(),
});

type CreateOrUpdateEntityArgs = z.infer<typeof CreateOrUpdateEntitySchema>;

interface EntityUpsertResult {
  path: string;
  created_or_updated: 'created' | 'updated';
}

function rawHasOwn(args: unknown, key: string): boolean {
  return typeof args === 'object' && args !== null && Object.prototype.hasOwnProperty.call(args, key);
}

function setIfProvided<T extends keyof CreateOrUpdateEntityArgs>(
  fm: Record<string, any>,
  args: CreateOrUpdateEntityArgs,
  key: T,
): void {
  if (args[key] !== undefined) fm[key as string] = args[key];
}

async function createOrUpdateEntityValue(args: unknown, ctx: ToolCtx): Promise<EntityUpsertResult> {
  const a = CreateOrUpdateEntitySchema.parse(args);
  const slug = toKebabSlug(a.name);
  if (slug === '') throw new McpError('INVALID_FILENAME', `name produces empty slug: '${a.name}'`);
  const rel = `_entities/${slug}.md`;

  await ownerCheck(ctx, rel, a.as_agent);
  const access = await ctx.index.getOwnershipResolver().resolveAccess(rel, a.as_agent);
  const canCurateProtected = isVaultAdmin(a.as_agent) || access.scope === 'primary';

  const safe = safeJoin(ctx.vaultRoot, rel);
  const existing = await statFile(safe);
  let priorFm: Record<string, any> | null = null;
  let priorBody = '';
  if (existing) {
    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    priorFm = parsed.frontmatter;
    priorBody = parsed.body;
  }

  if (!canCurateProtected) {
    for (const field of ['verified_by', 'verified_at', 'superseded_by']) {
      if (rawHasOwn(args, field)) {
        throw new McpError('PROTECTED_FIELD_VIOLATION', `Delegated entity author '${a.as_agent}' cannot set protected entity field '${field}'.`);
      }
    }
    if (priorFm?.entity_type !== undefined && priorFm.entity_type !== a.entity_type) {
      throw new McpError('PROTECTED_FIELD_VIOLATION', `Delegated entity author '${a.as_agent}' cannot change entity_type for existing entity '${rel}'.`);
    }
    if (priorFm?.name !== undefined && priorFm.name !== a.name) {
      throw new McpError('PROTECTED_FIELD_VIOLATION', `Delegated entity author '${a.as_agent}' cannot change canonical entity name for existing entity '${rel}'.`);
    }
  }

  const writeDate = today();
  const effectiveSource = a.source ?? priorFm?.source ?? config.defaultAgentSource;
  if (!canCurateProtected && effectiveSource === 'human-curated') {
    throw new McpError('TRUST_POLICY_VIOLATION', `Delegated entity author '${a.as_agent}' cannot write entity source 'human-curated'.`);
  }

  const fm: Record<string, any> = {
    ...(priorFm ?? {}),
    schema_version: 1,
    type: 'entity',
    status: a.status ?? priorFm?.status ?? 'active',
    created: priorFm?.created ?? writeDate,
    updated: writeDate,
    source: effectiveSource,
    tags: a.tags ?? priorFm?.tags ?? [],
    author_agent: a.as_agent,
    name: a.name,
    entity_type: a.entity_type,
  };
  setIfProvided(fm, a, 'aliases');
  setIfProvided(fm, a, 'external_ids');
  setIfProvided(fm, a, 'mentions_entity');
  setIfProvided(fm, a, 'related');
  setIfProvided(fm, a, 'confidence');
  if (canCurateProtected) {
    setIfProvided(fm, a, 'verified_by');
    setIfProvided(fm, a, 'verified_at');
    setIfProvided(fm, a, 'superseded_by');
  } else if (!Object.prototype.hasOwnProperty.call(fm, 'verified_by')) {
    fm.verified_by = null;
  }

  const body = a.content ?? priorBody;
  const assembled = serializeFrontmatter(fm, body);
  parseFrontmatter(assembled);
  assertRenoResolvedWikilinkOnCreate(ctx, {
    rel,
    content: assembled,
    frontmatter: fm,
    actor: a.as_agent,
    existing: Boolean(existing),
  });

  await lockPathsForWrite(ctx, [rel]);
  await writeFileAtomic(safe, assembled);
  await ctx.index.updateAfterWrite(rel);
  setLastWriteTs();
  log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'create_or_update_entity', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
  await enqueueWriteJob(ctx, { path: rel, message: `[mcp] create_or_update_entity: ${rel}`, as_agent: a.as_agent, tool: 'create_or_update_entity' });
  return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
}

export async function createOrUpdateEntity(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    return await createOrUpdateEntityValue(args, ctx);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const UpsertEntityProfileSchema = z.object({
  as_agent: z.string().min(1),
  entity_type: z.string().regex(KEBAB_SEG, 'entity_type must be kebab single-segment'),
  entity_name: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional().default([]),
  status: EntityStatusSchema.optional(),
});

export async function upsertEntityProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  if (config.legacyToolMode === 'error') {
    return new McpError(
      'DEPRECATED_TOOL',
      'upsert_entity_profile is deprecated; use create_or_update_entity.',
      'Use create_or_update_entity to create or update Schema v1 entities in _entities/.',
    ).toMcpResponse();
  }

  const r = await tryToolBody(async () => {
    const a = UpsertEntityProfileSchema.parse(args);
    const created = await createOrUpdateEntityValue({
      as_agent: a.as_agent,
      name: a.entity_name,
      entity_type: a.entity_type,
      content: a.content,
      tags: a.tags,
      status: a.status,
    }, ctx);
    return {
      ...created,
      deprecated: true,
      legacy_tool: 'upsert_entity_profile',
      redirected_to: 'create_or_update_entity',
      legacy_tool_mode: config.legacyToolMode,
      new_path: created.path,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── validation / external-id lookup ─────────────────────────────────────────

export const ValidateNoteSchema = z.object({
  path: z.string().min(1),
  content: z.string().optional(),
});

export async function validateNote(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ValidateNoteSchema.parse(args);
    const rel = normalizeRelPath(a.path);
    const content = a.content ?? (await readFileAtomic(safeJoin(ctx.vaultRoot, rel))).content;
    const diagnostics = await validateNoteContent(ctx, rel, content);
    const recommendedTool = recommendedValidationTool(rel, diagnostics.frontmatter);
    return {
      valid: diagnostics.errors.length === 0,
      errors: diagnostics.errors,
      warnings: diagnostics.warnings,
      normalized_frontmatter_preview: diagnostics.frontmatter ?? {},
      ...(recommendedTool ? { recommended_tool: recommendedTool } : {}),
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, (r.value as any).valid ? 'Note is valid' : 'Note has validation findings');
}

export const ValidateVaultSchema = z.object({}).passthrough();

export async function validateVault(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    ValidateVaultSchema.parse(args);
    const targets = existingWikiTargets(ctx.index.allEntries());
    const findings: ValidationFinding[] = [];

    for (const entry of ctx.index.allEntries().sort((a, b) => a.path.localeCompare(b.path))) {
      const rel = normalizeRelPath(entry.path);
      let content: string;
      try {
        content = (await readFileAtomic(safeJoin(ctx.vaultRoot, rel))).content;
      } catch (err) {
        findings.push(validationFinding('schema_error', rel, validationErrorMessage(err)));
        continue;
      }

      const diagnostics = await validateNoteContent(ctx, rel, content, targets);
      findings.push(...diagnostics.errors, ...diagnostics.warnings);
      findings.push(...brokenLinkFindings(rel, content, targets));
    }

    const counts = validationCounts();
    for (const finding of findings) counts[finding.category] += 1;

    return {
      categories: [...VALIDATION_CATEGORIES],
      findings,
      counts,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).findings.length} validation finding(s)`);
}

export const ScanSensitiveDataSchema = z.object({
  path_prefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional().default(20),
  include_examples: z.boolean().optional().default(false),
});

export async function scanSensitiveData(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ScanSensitiveDataSchema.parse(args ?? {});
    return await scanSensitiveIndex(ctx.vaultRoot, ctx.index, a);
  });
  if (!r.ok) return r.err.toMcpResponse();
  const sc = r.value as any;
  return ok(sc, `Sensitive scan: ${sc.files_with_findings}/${sc.files_scanned} file(s) with findings`);
}

export const FindEntityByExternalIdSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});

export async function findEntityByExternalId(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = FindEntityByExternalIdSchema.parse(args);
    const candidates = ctx.index.allEntries()
      .filter((entry) => entry.path.startsWith('_entities/') && entry.path.endsWith('.md'))
      .filter((entry) => entry.frontmatter?.external_ids?.[a.key] === a.value)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({
        path: entry.path,
        frontmatter: summarizeFrontmatter(entry.frontmatter!),
        trust: computeTrustLevel(entry.frontmatter, config.humanVerifiers),
      }));

    return { candidates };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).candidates.length} candidate(s)`);
}

// ─── search_by_tag / search_by_type / get_backlinks ──────────────────────────

export const SearchByTagSchema = z.object({
  tag: z.string().min(1),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  min_trust: z.enum(['any', 'verified', 'human']).optional().default('any'),
});

export async function searchByTag(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchByTagSchema.parse(args);
    const timeWindow = validateTimeRange(a.since, a.until);
    const owners = await validateOwners(ctx, a.owner);
    let notes = ctx.index.byTag(a.tag);
    if (owners) notes = notes.filter(e => e.owner !== null && owners.includes(e.owner));
    if (timeWindow.sinceMs !== null || timeWindow.untilMs !== null) {
      notes = notes.filter(e => mtimeInWindow(e.mtimeMs, timeWindow));
    }
    return {
      notes: notes
        .map(e => ({ path: e.path, type: e.type, owner: e.owner, ...computeTrustLevel(e.frontmatter, config.humanVerifiers) }))
        .filter(e => passesMinTrust(e, a.min_trust)),
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} note(s) tagged`);
}

export const SearchByTypeSchema = z.object({
  type: z.string().min(1),
  owner: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  min_trust: z.enum(['any', 'verified', 'human']).optional().default('any'),
});

export async function searchByType(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = SearchByTypeSchema.parse(args);
    const timeWindow = validateTimeRange(a.since, a.until);
    const owners = await validateOwners(ctx, a.owner);
    let notes = ctx.index.byType(a.type);
    if (owners) notes = notes.filter(e => e.owner !== null && owners.includes(e.owner));
    if (timeWindow.sinceMs !== null || timeWindow.untilMs !== null) {
      notes = notes.filter(e => mtimeInWindow(e.mtimeMs, timeWindow));
    }
    return {
      notes: notes
        .map(e => ({ path: e.path, type: e.type, owner: e.owner, ...computeTrustLevel(e.frontmatter, config.humanVerifiers) }))
        .filter(e => passesMinTrust(e, a.min_trust)),
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} note(s) of type`);
}

export const GetBacklinksSchema = z.object({ note_name: z.string().min(1) });

export async function getBacklinks(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetBacklinksSchema.parse(args);
    return { notes: ctx.index.backlinks(a.note_name).map(e => ({ path: e.path, line: 0 })) };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).notes.length} backlink(s)`);
}

// ─── upsert_lead_timeline ────────────────────────────────────────────────────

function entityPathForName(name: string, label: string): { slug: string; rel: string } {
  const slug = toKebabSlug(name);
  if (slug === '') throw new McpError('INVALID_FILENAME', `${label} '${name}' produces empty slug`);
  return { slug, rel: `_entities/${slug}.md` };
}

function compactExternalIds(input: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function entityLinksFor(ctx: ToolCtx, agent: string, slug: string): string[] {
  const links = [`[[${slug}]]`];
  const hubStem = `${agent}-hub`;
  if (ctx.index.get(`_hubs/${hubStem}.md`)) links.push(`[[${hubStem}]]`);
  return links;
}

async function createInteractionJournal(
  ctx: ToolCtx,
  input: {
    agent: string;
    entitySlug: string;
    entityPath: string;
    entityKind: 'lead' | 'broker';
    entityName: string;
    channel: string;
    summary: string;
    timestamp?: string;
    tags: string[];
    extra?: Record<string, string | null | undefined>;
  },
): Promise<{ path: string; occurred_at?: string; event_date: string }> {
  const dates = eventDateFromInput(undefined, input.timestamp);
  const title = `${input.entityName} ${input.summary}`;
  const titleSlug = toKebabSlug(title);
  if (titleSlug === '') throw new McpError('INVALID_FILENAME', `interaction summary '${input.summary}' produces empty slug`);
  const filename = `${dates.eventDate}-${titleSlug}.md`;
  validateJournalFilename(filename);
  const rel = `_journal/${input.agent}/${filename}`;
  await ownerCheck(ctx, rel, input.agent);
  const safe = safeJoin(ctx.vaultRoot, rel);
  if (await statFile(safe)) throw new McpError('JOURNAL_IMMUTABLE', `Journal entry already exists: ${rel}.`);

  const tagOut = normalizeTags(input.tags);
  const related = entityLinksFor(ctx, input.agent, input.entitySlug);
  const fm: Record<string, any> = {
    schema_version: 1,
    type: 'interaction',
    status: 'active',
    created: today(),
    updated: today(),
    source: config.defaultAgentSource,
    author_agent: input.agent,
    tags: tagOut.tags,
    title,
    event_date: dates.eventDate,
    channel: input.channel,
    participants: [input.agent, `${input.entityKind}:${input.entitySlug}`],
    mentions_entity: [input.entityPath],
    related,
    entity_kind: input.entityKind,
    entity_name: input.entityName,
    summary: input.summary,
  };
  if (dates.occurredAt) fm.occurred_at = dates.occurredAt;
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (value !== undefined && value !== null) fm[key] = value;
  }

  const extraLines = Object.entries(input.extra ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${value}`);
  const body = [
    `# ${title}`,
    '',
    `Entity: [[${input.entitySlug}]]`,
    `Kind: ${input.entityKind}`,
    `Channel: ${input.channel}`,
    `Summary: ${input.summary}`,
    ...extraLines,
    '',
  ].join('\n');
  const assembled = serializeFrontmatter(fm, body);
  parseFrontmatter(assembled);
  assertRenoResolvedWikilinkOnCreate(ctx, {
    rel,
    content: assembled,
    frontmatter: fm,
    actor: input.agent,
    existing: false,
  });

  await lockPathsForWrite(ctx, [rel]);
  await writeFileExclusiveAtomic(
    safe,
    assembled,
    new McpError('JOURNAL_IMMUTABLE', `Journal entry already exists: ${rel}.`),
  );
  await ctx.index.updateAfterWrite(rel);
  setLastWriteTs();
  await enqueueWriteJob(ctx, { path: rel, message: `[mcp] append_${input.entityKind}_interaction: ${rel}`, as_agent: input.agent, tool: `append_${input.entityKind}_interaction` });
  return { path: rel, occurred_at: dates.occurredAt, event_date: dates.eventDate };
}

async function journalInteractionsForEntity(
  ctx: ToolCtx,
  agent: string,
  entityPath: string,
  entitySlug: string,
  since: string | undefined,
  order: 'asc' | 'desc',
  limit: number | undefined,
): Promise<any[]> {
  const sinceMs = since ? Date.parse(since) : null;
  const out: any[] = [];
  for (const e of ctx.index.allEntries()) {
    if (!e.path.startsWith(`_journal/${agent}/`) || e.type !== 'interaction') continue;
    const fm = e.frontmatter ?? {};
    const related = JSON.stringify([fm.mentions_entity, fm.related, fm.entity_name]);
    if (!related.includes(entityPath) && !related.includes(entitySlug)) continue;
    const occurred = typeof fm.occurred_at === 'string' ? fm.occurred_at : (typeof fm.event_date === 'string' ? `${fm.event_date}T00:00:00.000Z` : null);
    const ms = occurred ? Date.parse(occurred) : e.mtimeMs;
    if (sinceMs !== null && ms < sinceMs) continue;
    out.push({
      timestamp: typeof fm.occurred_at === 'string' ? formatTimestamp(fm.occurred_at) : (fm.event_date ?? new Date(e.mtimeMs).toISOString()),
      channel: fm.channel ?? null,
      summary: fm.summary ?? fm.title ?? null,
      objection: fm.objection ?? null,
      next_step: fm.next_step ?? null,
      contexto_lead: fm.contexto_lead ?? null,
      dificuldade: fm.dificuldade ?? null,
      encaminhamento: fm.encaminhamento ?? null,
      path: e.path,
    });
  }
  out.sort((x, y) => order === 'asc'
    ? String(x.timestamp).localeCompare(String(y.timestamp))
    : String(y.timestamp).localeCompare(String(x.timestamp)));
  return limit ? out.slice(0, limit) : out;
}

export const UpsertLeadTimelineSchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  resumo: z.string().optional(),
  interesse_atual: z.string().optional(),
  objecoes_ativas: z.array(z.string()).optional(),
  proximo_passo: z.string().optional(),
  status_comercial: z.string().optional(),
  origem: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  client_id: z.number().int().positive().optional(),
  broker_id: z.number().int().positive().optional(),
  broker_name: z.string().optional(),
  empreendimento_id: z.number().int().positive().optional(),
  empreendimento_slug: z.string().optional(),
  empreendimento_name: z.string().optional(),
  fonte: z.string().optional(),
  regiao: z.string().optional(),
});

async function upsertLeadTimelineLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertLeadTimelineSchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;
    assertNoLegacyNamespaceWrite(rel);
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: LeadBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseLeadBody(parsed.body);
    }

    const mergedHeaders: LeadHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      interesse_atual: a.interesse_atual !== undefined ? a.interesse_atual : priorBody?.headers.interesse_atual ?? null,
      objecoes_ativas: a.objecoes_ativas !== undefined ? a.objecoes_ativas : priorBody?.headers.objecoes_ativas ?? null,
      proximo_passo: a.proximo_passo !== undefined ? a.proximo_passo : priorBody?.headers.proximo_passo ?? null,
    };

    const newBody: LeadBody = {
      headers: mergedHeaders,
      interactions: priorBody?.interactions ?? [],
      malformed_blocks: [],
    };

    const refInputs: EntityRefInputs = {
      client_id: a.client_id,
      broker_id: a.broker_id,
      empreendimento_id: a.empreendimento_id,
      empreendimento_slug: a.empreendimento_slug,
      fonte: a.fonte,
      regiao: a.regiao,
      display_names: {
        client: a.lead_name,
        broker: a.broker_name,
        empreendimento: a.empreendimento_name,
      },
    };
    const refs = collectEntityRefs(refInputs, priorFm);
    const { stems, stubs_created } = await resolveAndEnsureStubs(ctx, refs, a.as_agent);

    const tagInput = a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []);
    const tagOut = normalizeTags(tagInput);

    const fm: Record<string, any> = {
      type: 'entity-profile',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: tagOut.tags,
      entity_type: 'lead',
      entity_name: a.lead_name,
    };
    if (a.status_comercial !== undefined) fm.status_comercial = a.status_comercial;
    else if (priorFm?.status_comercial) fm.status_comercial = priorFm.status_comercial;
    if (a.origem !== undefined) fm.origem = a.origem;
    else if (priorFm?.origem) fm.origem = priorFm.origem;
    if (mergedHeaders.interesse_atual) fm.interesse_atual = mergedHeaders.interesse_atual;
    if (mergedHeaders.objecoes_ativas) fm.objecoes_ativas = mergedHeaders.objecoes_ativas;
    if (mergedHeaders.proximo_passo) fm.proximo_passo = mergedHeaders.proximo_passo;
    applyEntityRefsToFrontmatter(fm, refInputs, priorFm, stems);

    const bodyText = injectVinculosLine(serializeLeadBody(newBody), stems);
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, bodyText));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_lead_timeline', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_lead_timeline: ${rel}`, as_agent: a.as_agent, tool: 'upsert_lead_timeline' });
    return {
      path: rel,
      created_or_updated: existing ? 'updated' : 'created',
      wikilinks: stems,
      stubs_created,
      tag_warnings: tagOut.warnings.length > 0 ? tagOut.warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── append_lead_interaction ─────────────────────────────────────────────────

export async function upsertLeadTimeline(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertLeadTimelineSchema.parse(args);
    const { slug, rel } = entityPathForName(a.lead_name, 'lead_name');
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: LeadBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseLeadBody(parsed.body);
    }

    const mergedHeaders: LeadHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      interesse_atual: a.interesse_atual !== undefined ? a.interesse_atual : priorBody?.headers.interesse_atual ?? null,
      objecoes_ativas: a.objecoes_ativas !== undefined ? a.objecoes_ativas : priorBody?.headers.objecoes_ativas ?? null,
      proximo_passo: a.proximo_passo !== undefined ? a.proximo_passo : priorBody?.headers.proximo_passo ?? null,
    };
    const bodyModel: LeadBody = {
      headers: mergedHeaders,
      interactions: [],
      malformed_blocks: [],
    };

    const tagInput = a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []);
    const tagOut = normalizeTags(tagInput);
    const related = entityLinksFor(ctx, a.as_agent, slug);
    const externalIds = compactExternalIds({
      client_id: a.client_id,
      broker_id: a.broker_id,
      empreendimento_id: a.empreendimento_id,
      empreendimento_slug: a.empreendimento_slug,
      fonte: a.fonte,
      regiao: a.regiao,
    }) ?? priorFm?.external_ids;

    const fm: Record<string, any> = {
      ...(priorFm ?? {}),
      schema_version: 1,
      type: 'entity',
      status: priorFm?.status ?? 'active',
      created: priorFm?.created ?? today(),
      updated: today(),
      source: priorFm?.source ?? config.defaultAgentSource,
      tags: tagOut.tags,
      author_agent: a.as_agent,
      name: a.lead_name,
      entity_type: 'lead',
      related,
    };
    if (externalIds) fm.external_ids = externalIds;
    if (a.status_comercial !== undefined) fm.status_comercial = a.status_comercial;
    else if (priorFm?.status_comercial !== undefined) fm.status_comercial = priorFm.status_comercial;
    if (a.origem !== undefined) fm.origem = a.origem;
    else if (priorFm?.origem !== undefined) fm.origem = priorFm.origem;
    if (mergedHeaders.interesse_atual) fm.interesse_atual = mergedHeaders.interesse_atual;
    if (mergedHeaders.objecoes_ativas) fm.objecoes_ativas = mergedHeaders.objecoes_ativas;
    if (mergedHeaders.proximo_passo) fm.proximo_passo = mergedHeaders.proximo_passo;

    const bodyText = `${related.join(' ')}\n\n${serializeLeadBody(bodyModel)}`;
    const assembled = serializeFrontmatter(fm, bodyText);
    parseFrontmatter(assembled);
    assertRenoResolvedWikilinkOnCreate(ctx, {
      rel,
      content: assembled,
      frontmatter: fm,
      actor: a.as_agent,
      existing: Boolean(existing),
    });

    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_lead_timeline', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_lead_timeline: ${rel}`, as_agent: a.as_agent, tool: 'upsert_lead_timeline' });
    return {
      path: rel,
      entity_path: rel,
      created_or_updated: existing ? 'updated' : 'created',
      wikilinks: related,
      stubs_created: [],
      tag_warnings: tagOut.warnings.length > 0 ? tagOut.warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const AppendLeadInteractionSchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  channel: z.string().min(1),
  summary: z.string().min(1),
  origem: z.string().optional(),
  objection: z.string().optional(),
  next_step: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  timestamp: z.string().datetime().optional(),
  client_id: z.number().int().positive().optional(),
  broker_id: z.number().int().positive().optional(),
  broker_name: z.string().optional(),
  empreendimento_id: z.number().int().positive().optional(),
  empreendimento_slug: z.string().optional(),
  empreendimento_name: z.string().optional(),
  fonte: z.string().optional(),
  regiao: z.string().optional(),
});

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function appendLeadInteractionLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendLeadInteractionSchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;
    assertNoLegacyNamespaceWrite(rel);
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) {
      throw new McpError('LEAD_NOT_FOUND', `Lead doc not found: ${rel}. Run upsert_lead_timeline first.`);
    }

    const ts = formatTimestamp(a.timestamp ?? new Date().toISOString());
    const tagOut = normalizeTags(a.tags);
    const interaction: LeadInteraction = {
      timestamp: ts,
      channel: a.channel,
      origem: a.origem ?? null,
      summary: a.summary,
      objection: a.objection ?? null,
      next_step: a.next_step ?? null,
      tags: tagOut.tags,
    };

    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    const priorFm = parsed.frontmatter;

    const refInputs: EntityRefInputs = {
      client_id: a.client_id,
      broker_id: a.broker_id,
      empreendimento_id: a.empreendimento_id,
      empreendimento_slug: a.empreendimento_slug,
      fonte: a.fonte,
      regiao: a.regiao,
      display_names: {
        client: a.lead_name,
        broker: a.broker_name,
        empreendimento: a.empreendimento_name,
      },
    };
    const refs = collectEntityRefs(refInputs, priorFm);
    const { stems, stubs_created } = await resolveAndEnsureStubs(ctx, refs, a.as_agent);

    let workingBody = parsed.body;
    if (stems.length > 0) {
      workingBody = injectVinculosLine(workingBody, stems);
    }

    let newBodyText: string;
    if (workingBody.includes('## Histórico de interações')) {
      newBodyText = workingBody.trimEnd() + '\n\n' + serializeInteractionBlock(interaction) + '\n';
    } else {
      newBodyText = workingBody.trimEnd() + '\n\n## Histórico de interações\n\n' + serializeInteractionBlock(interaction) + '\n';
    }

    const fm = { ...(priorFm ?? {}), updated: today() };
    applyEntityRefsToFrontmatter(fm, refInputs, priorFm, stems);
    const fullNew = serializeFrontmatter(fm, newBodyText);
    const appendBytes = fullNew.length - raw.length;

    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, fullNew);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_lead_interaction', as_agent: a.as_agent, path: rel, action: 'append', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] append_lead_interaction: ${rel}`, as_agent: a.as_agent, tool: 'append_lead_interaction' });
    return {
      path: rel,
      bytes_appended: appendBytes,
      block_inserted_at: ts,
      wikilinks: stems,
      stubs_created,
      tag_warnings: tagOut.warnings.length > 0 ? tagOut.warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Appended interaction at ${(r.value as any).block_inserted_at} to ${(r.value as any).path}`);
}

// ─── read_lead_history ───────────────────────────────────────────────────────

export async function appendLeadInteraction(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendLeadInteractionSchema.parse(args);
    const { slug, rel: entityRel } = entityPathForName(a.lead_name, 'lead_name');
    const entitySafe = safeJoin(ctx.vaultRoot, entityRel);
    if (!await statFile(entitySafe)) {
      throw new McpError('LEAD_NOT_FOUND', `Lead entity not found: ${entityRel}. Run upsert_lead_timeline first.`);
    }

    const created = await createInteractionJournal(ctx, {
      agent: a.as_agent,
      entitySlug: slug,
      entityPath: entityRel,
      entityKind: 'lead',
      entityName: a.lead_name,
      channel: a.channel,
      summary: a.summary,
      timestamp: a.timestamp,
      tags: a.tags,
      extra: {
        origem: a.origem,
        objection: a.objection,
        next_step: a.next_step,
      },
    });

    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_lead_interaction', as_agent: a.as_agent, path: created.path, action: 'append', outcome: 'ok' });
    return {
      path: created.path,
      entity_path: entityRel,
      block_inserted_at: created.occurred_at ?? created.event_date,
      bytes_appended: 0,
      wikilinks: entityLinksFor(ctx, a.as_agent, slug),
      stubs_created: [],
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Created lead interaction ${(r.value as any).path}`);
}

export const ReadLeadHistorySchema = z.object({
  as_agent: z.string().min(1),
  lead_name: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

async function readLeadHistoryLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadLeadHistorySchema.parse(args);
    const slug = toKebabSlug(a.lead_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `lead_name '${a.lead_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/lead/${slug}.md`;

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('LEAD_NOT_FOUND', `Lead doc not found: ${rel}. Run upsert_lead_timeline first.`);

    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const lead = parseLeadBody(body);

    let interactions = lead.interactions;

    if (a.since) {
      const sinceTs = formatTimestamp(a.since);
      interactions = interactions.filter(i => i.timestamp >= sinceTs);
    }
    interactions = [...interactions].sort((x, y) => a.order === 'asc'
      ? x.timestamp.localeCompare(y.timestamp)
      : y.timestamp.localeCompare(x.timestamp));
    if (a.limit) interactions = interactions.slice(0, a.limit);

    const warnings = lead.malformed_blocks.map(m => ({ code: 'MALFORMED_LEAD_BODY', line: m.line, reason: m.reason }));

    return {
      lead: {
        entity_name: frontmatter?.entity_name ?? a.lead_name,
        status_comercial: frontmatter?.status_comercial ?? null,
        origem: frontmatter?.origem ?? null,
        resumo: lead.headers.resumo,
        interesse_atual: lead.headers.interesse_atual,
        objecoes_ativas: lead.headers.objecoes_ativas,
        proximo_passo: lead.headers.proximo_passo,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Lead '${(r.value as any).lead.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}

// ─── upsert_broker_profile ───────────────────────────────────────────────────

export async function readLeadHistory(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const parsedArgs = ReadLeadHistorySchema.safeParse(args);
  if (!parsedArgs.success) return await readLeadHistoryLegacy(args, ctx);
  const a = parsedArgs.data;
  const { slug, rel } = entityPathForName(a.lead_name, 'lead_name');
  const safe = safeJoin(ctx.vaultRoot, rel);
  if (!await statFile(safe)) return await readLeadHistoryLegacy(args, ctx);

  const r = await tryToolBody(async () => {
    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const lead = parseLeadBody(body);
    const interactions = await journalInteractionsForEntity(ctx, a.as_agent, rel, slug, a.since, a.order, a.limit);
    const warnings = lead.malformed_blocks.map(m => ({ code: 'MALFORMED_LEAD_BODY', line: m.line, reason: m.reason }));
    return {
      lead: {
        path: rel,
        entity_name: frontmatter?.name ?? frontmatter?.entity_name ?? a.lead_name,
        status_comercial: frontmatter?.status_comercial ?? null,
        origem: frontmatter?.origem ?? null,
        resumo: lead.headers.resumo,
        interesse_atual: lead.headers.interesse_atual,
        objecoes_ativas: lead.headers.objecoes_ativas,
        proximo_passo: lead.headers.proximo_passo,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Lead '${(r.value as any).lead.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}

export const UpsertBrokerProfileSchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  resumo: z.string().optional(),
  comunicacao: z.string().optional(),
  padroes_atendimento: z.string().optional(),
  pendencias_abertas: z.array(z.string()).optional(),
  equipe: z.string().optional(),
  nivel_engajamento: z.string().optional(),
  comunicacao_estilo: z.string().optional(),
  contato_email: z.string().optional(),
  contato_whatsapp: z.string().optional(),
  dificuldades_recorrentes: z.array(z.string()).optional(),
  nivel_atencao: z.string().optional(),
  ultima_acao_recomendada: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  broker_id: z.number().int().positive().optional(),
  empreendimento_id: z.number().int().positive().optional(),
  empreendimento_slug: z.string().optional(),
  empreendimento_name: z.string().optional(),
  regiao: z.string().optional(),
});

async function upsertBrokerProfileLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertBrokerProfileSchema.parse(args);
    if (typeof a.ultima_acao_recomendada === 'string' && a.ultima_acao_recomendada.includes('\n')) {
      throw new McpError('INVALID_FRONTMATTER', 'ultima_acao_recomendada must be one line (no newline)');
    }
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    assertNoLegacyNamespaceWrite(rel);
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: BrokerBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseBrokerBody(parsed.body);
    }

    const mergedHeaders: BrokerHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      comunicacao: a.comunicacao !== undefined ? a.comunicacao : priorBody?.headers.comunicacao ?? null,
      padroes_atendimento: a.padroes_atendimento !== undefined ? a.padroes_atendimento : priorBody?.headers.padroes_atendimento ?? null,
      pendencias_abertas: a.pendencias_abertas !== undefined ? a.pendencias_abertas : priorBody?.headers.pendencias_abertas ?? null,
    };

    const newBody: BrokerBody = {
      headers: mergedHeaders,
      interactions: priorBody?.interactions ?? [],
      malformed_blocks: [],
    };

    const refInputs: EntityRefInputs = {
      broker_id: a.broker_id,
      empreendimento_id: a.empreendimento_id,
      empreendimento_slug: a.empreendimento_slug,
      regiao: a.regiao,
      display_names: {
        broker: a.broker_name,
        empreendimento: a.empreendimento_name,
      },
    };
    const refs = collectEntityRefs(refInputs, priorFm);
    const { stems, stubs_created } = await resolveAndEnsureStubs(ctx, refs, a.as_agent);

    const tagInput = a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []);
    const tagOut = normalizeTags(tagInput);

    const fm: Record<string, any> = {
      type: 'entity-profile',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: tagOut.tags,
      entity_type: 'broker',
      entity_name: a.broker_name,
    };
    for (const field of ['equipe', 'nivel_engajamento', 'comunicacao_estilo', 'contato_email', 'contato_whatsapp', 'padroes_atendimento', 'nivel_atencao', 'ultima_acao_recomendada'] as const) {
      const passed = (a as any)[field];
      if (passed !== undefined) fm[field] = passed;
      else if (priorFm?.[field] !== undefined) fm[field] = priorFm[field];
    }
    for (const listField of ['dificuldades_recorrentes', 'pendencias_abertas'] as const) {
      const passed = (a as any)[listField];
      if (passed !== undefined) fm[listField] = passed;
      else if (priorFm?.[listField] !== undefined) fm[listField] = priorFm[listField];
    }
    if (mergedHeaders.pendencias_abertas !== null) fm.pendencias_abertas = mergedHeaders.pendencias_abertas;
    applyEntityRefsToFrontmatter(fm, refInputs, priorFm, stems);

    const bodyText = injectVinculosLine(serializeBrokerBody(newBody), stems);
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, bodyText));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_broker_profile', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_broker_profile: ${rel}`, as_agent: a.as_agent, tool: 'upsert_broker_profile' });
    return {
      path: rel,
      created_or_updated: existing ? 'updated' : 'created',
      wikilinks: stems,
      stubs_created,
      tag_warnings: tagOut.warnings.length > 0 ? tagOut.warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

// ─── append_broker_interaction ───────────────────────────────────────────────

export async function upsertBrokerProfile(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertBrokerProfileSchema.parse(args);
    if (typeof a.ultima_acao_recomendada === 'string' && a.ultima_acao_recomendada.includes('\n')) {
      throw new McpError('INVALID_FRONTMATTER', 'ultima_acao_recomendada must be one line (no newline)');
    }
    const { slug, rel } = entityPathForName(a.broker_name, 'broker_name');
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    let priorFm: Record<string, any> | null = null;
    let priorBody: BrokerBody | null = null;
    if (existing) {
      const raw = (await readFileAtomic(safe)).content;
      const parsed = parseFrontmatter(raw);
      priorFm = parsed.frontmatter;
      priorBody = parseBrokerBody(parsed.body);
    }

    const mergedHeaders: BrokerHeaders = {
      resumo: a.resumo !== undefined ? a.resumo : priorBody?.headers.resumo ?? null,
      comunicacao: a.comunicacao !== undefined ? a.comunicacao : priorBody?.headers.comunicacao ?? null,
      padroes_atendimento: a.padroes_atendimento !== undefined ? a.padroes_atendimento : priorBody?.headers.padroes_atendimento ?? null,
      pendencias_abertas: a.pendencias_abertas !== undefined ? a.pendencias_abertas : priorBody?.headers.pendencias_abertas ?? null,
    };
    const bodyModel: BrokerBody = {
      headers: mergedHeaders,
      interactions: [],
      malformed_blocks: [],
    };
    const tagInput = a.tags.length > 0 ? a.tags : (priorFm?.tags ?? []);
    const tagOut = normalizeTags(tagInput);
    const related = entityLinksFor(ctx, a.as_agent, slug);
    const externalIds = compactExternalIds({
      broker_id: a.broker_id,
      empreendimento_id: a.empreendimento_id,
      empreendimento_slug: a.empreendimento_slug,
      regiao: a.regiao,
    }) ?? priorFm?.external_ids;

    const fm: Record<string, any> = {
      ...(priorFm ?? {}),
      schema_version: 1,
      type: 'entity',
      status: priorFm?.status ?? 'active',
      created: priorFm?.created ?? today(),
      updated: today(),
      source: priorFm?.source ?? config.defaultAgentSource,
      tags: tagOut.tags,
      author_agent: a.as_agent,
      name: a.broker_name,
      entity_type: 'broker',
      related,
    };
    if (externalIds) fm.external_ids = externalIds;
    for (const field of ['equipe', 'nivel_engajamento', 'comunicacao_estilo', 'contato_email', 'contato_whatsapp', 'padroes_atendimento', 'nivel_atencao', 'ultima_acao_recomendada'] as const) {
      const passed = (a as any)[field];
      if (passed !== undefined) fm[field] = passed;
      else if (priorFm?.[field] !== undefined) fm[field] = priorFm[field];
    }
    for (const listField of ['dificuldades_recorrentes', 'pendencias_abertas'] as const) {
      const passed = (a as any)[listField];
      if (passed !== undefined) fm[listField] = passed;
      else if (priorFm?.[listField] !== undefined) fm[listField] = priorFm[listField];
    }
    if (mergedHeaders.pendencias_abertas !== null) fm.pendencias_abertas = mergedHeaders.pendencias_abertas;

    const bodyText = `${related.join(' ')}\n\n${serializeBrokerBody(bodyModel)}`;
    const assembled = serializeFrontmatter(fm, bodyText);
    parseFrontmatter(assembled);
    assertRenoResolvedWikilinkOnCreate(ctx, {
      rel,
      content: assembled,
      frontmatter: fm,
      actor: a.as_agent,
      existing: Boolean(existing),
    });

    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, assembled);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_broker_profile', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_broker_profile: ${rel}`, as_agent: a.as_agent, tool: 'upsert_broker_profile' });
    return {
      path: rel,
      entity_path: rel,
      created_or_updated: existing ? 'updated' : 'created',
      wikilinks: related,
      stubs_created: [],
      tag_warnings: tagOut.warnings.length > 0 ? tagOut.warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const AppendBrokerInteractionSchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  channel: z.string().min(1),
  summary: z.string().min(1),
  contexto_lead: z.string().optional(),
  dificuldade: z.string().optional(),
  encaminhamento: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  timestamp: z.string().datetime().optional(),
  broker_id: z.number().int().positive().optional(),
  empreendimento_id: z.number().int().positive().optional(),
  empreendimento_slug: z.string().optional(),
  empreendimento_name: z.string().optional(),
  client_id: z.number().int().positive().optional(),
  client_name: z.string().optional(),
  regiao: z.string().optional(),
});

async function appendBrokerInteractionLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendBrokerInteractionSchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    assertNoLegacyNamespaceWrite(rel);
    await ownerCheck(ctx, rel, a.as_agent);

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}. Run upsert_broker_profile first.`);

    const ts = formatTimestamp(a.timestamp ?? new Date().toISOString());
    const tagOut = normalizeTags(a.tags);
    const interaction: BrokerInteraction = {
      timestamp: ts,
      channel: a.channel,
      contexto_lead: a.contexto_lead ?? null,
      summary: a.summary,
      dificuldade: a.dificuldade ?? null,
      encaminhamento: a.encaminhamento ?? null,
      tags: tagOut.tags,
    };

    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    const priorFm = parsed.frontmatter;

    const refInputs: EntityRefInputs = {
      broker_id: a.broker_id,
      client_id: a.client_id,
      empreendimento_id: a.empreendimento_id,
      empreendimento_slug: a.empreendimento_slug,
      regiao: a.regiao,
      display_names: {
        broker: a.broker_name,
        client: a.client_name,
        empreendimento: a.empreendimento_name,
      },
    };
    const refs = collectEntityRefs(refInputs, priorFm);
    const { stems, stubs_created } = await resolveAndEnsureStubs(ctx, refs, a.as_agent);

    let workingBody = parsed.body;
    if (stems.length > 0) {
      workingBody = injectVinculosLine(workingBody, stems);
    }

    let newBodyText: string;
    if (workingBody.includes('## Histórico de interações')) {
      newBodyText = workingBody.trimEnd() + '\n\n' + serializeBrokerInteraction(interaction) + '\n';
    } else {
      newBodyText = workingBody.trimEnd() + '\n\n## Histórico de interações\n\n' + serializeBrokerInteraction(interaction) + '\n';
    }
    const fm = { ...(priorFm ?? {}), updated: today() };
    applyEntityRefsToFrontmatter(fm, refInputs, priorFm, stems);
    const fullNew = serializeFrontmatter(fm, newBodyText);
    const appendBytes = fullNew.length - raw.length;

    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, fullNew);
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_broker_interaction', as_agent: a.as_agent, path: rel, action: 'append', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] append_broker_interaction: ${rel}`, as_agent: a.as_agent, tool: 'append_broker_interaction' });
    return {
      path: rel,
      bytes_appended: appendBytes,
      block_inserted_at: ts,
      wikilinks: stems,
      stubs_created,
      tag_warnings: tagOut.warnings.length > 0 ? tagOut.warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Appended broker interaction at ${(r.value as any).block_inserted_at}`);
}

// ─── read_broker_history ─────────────────────────────────────────────────────

export async function appendBrokerInteraction(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = AppendBrokerInteractionSchema.parse(args);
    const { slug, rel: entityRel } = entityPathForName(a.broker_name, 'broker_name');
    const entitySafe = safeJoin(ctx.vaultRoot, entityRel);
    if (!await statFile(entitySafe)) {
      throw new McpError('BROKER_NOT_FOUND', `Broker entity not found: ${entityRel}. Run upsert_broker_profile first.`);
    }

    const created = await createInteractionJournal(ctx, {
      agent: a.as_agent,
      entitySlug: slug,
      entityPath: entityRel,
      entityKind: 'broker',
      entityName: a.broker_name,
      channel: a.channel,
      summary: a.summary,
      timestamp: a.timestamp,
      tags: a.tags,
      extra: {
        contexto_lead: a.contexto_lead,
        dificuldade: a.dificuldade,
        encaminhamento: a.encaminhamento,
      },
    });

    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'append_broker_interaction', as_agent: a.as_agent, path: created.path, action: 'append', outcome: 'ok' });
    return {
      path: created.path,
      entity_path: entityRel,
      block_inserted_at: created.occurred_at ?? created.event_date,
      bytes_appended: 0,
      wikilinks: entityLinksFor(ctx, a.as_agent, slug),
      stubs_created: [],
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Created broker interaction ${(r.value as any).path}`);
}

export const ReadBrokerHistorySchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

async function readBrokerHistoryLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadBrokerHistorySchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `broker_name '${a.broker_name}' produces empty slug`);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;

    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}.`);

    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const broker = parseBrokerBody(body);

    let interactions = broker.interactions;
    if (a.since) {
      const sinceTs = formatTimestamp(a.since);
      interactions = interactions.filter(i => i.timestamp >= sinceTs);
    }
    interactions = [...interactions].sort((x, y) => a.order === 'asc'
      ? x.timestamp.localeCompare(y.timestamp)
      : y.timestamp.localeCompare(x.timestamp));
    if (a.limit) interactions = interactions.slice(0, a.limit);

    const warnings = broker.malformed_blocks.map(m => ({ code: 'MALFORMED_BROKER_BODY', line: m.line, reason: m.reason }));

    return {
      broker: {
        entity_name: frontmatter?.entity_name ?? a.broker_name,
        equipe: frontmatter?.equipe ?? null,
        nivel_engajamento: frontmatter?.nivel_engajamento ?? null,
        comunicacao_estilo: frontmatter?.comunicacao_estilo ?? null,
        contato_email: frontmatter?.contato_email ?? null,
        contato_whatsapp: frontmatter?.contato_whatsapp ?? null,
        dificuldades_recorrentes: frontmatter?.dificuldades_recorrentes ?? null,
        pendencias_abertas: broker.headers.pendencias_abertas ?? frontmatter?.pendencias_abertas ?? null,
        resumo: broker.headers.resumo,
        comunicacao: broker.headers.comunicacao,
        padroes_atendimento: broker.headers.padroes_atendimento,
        nivel_atencao: frontmatter?.nivel_atencao ?? null,
        ultima_acao_recomendada: frontmatter?.ultima_acao_recomendada ?? null,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Broker '${(r.value as any).broker.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}

// ─── get_broker_operational_summary ──────────────────────────────────────────

export async function readBrokerHistory(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const parsedArgs = ReadBrokerHistorySchema.safeParse(args);
  if (!parsedArgs.success) return await readBrokerHistoryLegacy(args, ctx);
  const a = parsedArgs.data;
  const { slug, rel } = entityPathForName(a.broker_name, 'broker_name');
  const safe = safeJoin(ctx.vaultRoot, rel);
  if (!await statFile(safe)) return await readBrokerHistoryLegacy(args, ctx);

  const r = await tryToolBody(async () => {
    const raw = (await readFileAtomic(safe)).content;
    const { frontmatter, body } = parseFrontmatter(raw);
    const broker = parseBrokerBody(body);
    const interactions = await journalInteractionsForEntity(ctx, a.as_agent, rel, slug, a.since, a.order, a.limit);
    const warnings = broker.malformed_blocks.map(m => ({ code: 'MALFORMED_BROKER_BODY', line: m.line, reason: m.reason }));
    return {
      broker: {
        path: rel,
        entity_name: frontmatter?.name ?? frontmatter?.entity_name ?? a.broker_name,
        equipe: frontmatter?.equipe ?? null,
        nivel_engajamento: frontmatter?.nivel_engajamento ?? null,
        comunicacao_estilo: frontmatter?.comunicacao_estilo ?? null,
        contato_email: frontmatter?.contato_email ?? null,
        contato_whatsapp: frontmatter?.contato_whatsapp ?? null,
        dificuldades_recorrentes: frontmatter?.dificuldades_recorrentes ?? null,
        pendencias_abertas: broker.headers.pendencias_abertas ?? frontmatter?.pendencias_abertas ?? null,
        resumo: broker.headers.resumo,
        comunicacao: broker.headers.comunicacao,
        padroes_atendimento: broker.headers.padroes_atendimento,
        nivel_atencao: frontmatter?.nivel_atencao ?? null,
        ultima_acao_recomendada: frontmatter?.ultima_acao_recomendada ?? null,
      },
      interactions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `Broker '${(r.value as any).broker.entity_name}': ${(r.value as any).interactions.length} interaction(s)`);
}

export const GetBrokerOperationalSummarySchema = z.object({
  as_agent: z.string().min(1),
  broker_name: z.string().min(1),
  n_recent_interactions: z.number().int().positive().optional().default(5),
  periodo_tendencia_dias: z.number().int().positive().optional().default(28),
});

interface DificuldadeCount { dificuldade: string; count: number; }

async function getBrokerOperationalSummaryLegacy(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = GetBrokerOperationalSummarySchema.parse(args);
    const slug = toKebabSlug(a.broker_name);
    const rel = `_agents/${a.as_agent}/broker/${slug}.md`;
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);
    if (!existing) {
      throw new McpError('BROKER_NOT_FOUND', `Broker doc not found: ${rel}. Run upsert_broker_profile first.`);
    }

    const { content } = await readFileAtomic(safe);
    const parsed = parseFrontmatter(content);
    const body = parseBrokerBody(parsed.body);
    const interactions = body.interactions.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const nowMs = Date.now();
    const periodMs = a.periodo_tendencia_dias * 86400_000;
    const atualStartMs = nowMs - periodMs;
    const anteriorStartMs = nowMs - 2 * periodMs;

    const parseTs = (ts: string): number => {
      // YYYY-MM-DD HH:MM (assume UTC for stability)
      const iso = ts.replace(' ', 'T') + ':00Z';
      return Date.parse(iso);
    };

    let diasDesdeUltima: number | null = null;
    if (interactions.length > 0) {
      const lastMs = parseTs(interactions[0].timestamp);
      diasDesdeUltima = Math.floor((nowMs - lastMs) / 86400_000);
    }

    let atual = 0;
    let anterior = 0;
    const difCounts = new Map<string, number>();
    for (const i of interactions) {
      const ms = parseTs(i.timestamp);
      if (ms >= atualStartMs) {
        atual++;
        const d = (i as any).dificuldade;
        if (typeof d === 'string' && d.trim() !== '') {
          difCounts.set(d, (difCounts.get(d) ?? 0) + 1);
        }
      } else if (ms >= anteriorStartMs) {
        anterior++;
      }
    }
    const dificuldadesRepetidas: DificuldadeCount[] = [];
    for (const [d, c] of difCounts) if (c >= 2) dificuldadesRepetidas.push({ dificuldade: d, count: c });

    const sinais: string[] = [];
    if (diasDesdeUltima !== null && diasDesdeUltima > 7) {
      sinais.push(`sem interação há ${diasDesdeUltima} dias`);
    }
    const fm = parsed.frontmatter ?? {};
    const pendenciasList: string[] = Array.isArray(fm.pendencias_abertas) ? fm.pendencias_abertas : [];
    if (pendenciasList.length >= 3) {
      sinais.push(`${pendenciasList.length} pendências abertas`);
    } else if (pendenciasList.length >= 1) {
      sinais.push(`${pendenciasList.length} pendência${pendenciasList.length > 1 ? 's' : ''} aberta${pendenciasList.length > 1 ? 's' : ''}`);
    }
    for (const { dificuldade, count } of dificuldadesRepetidas) {
      sinais.push(`dificuldade '${dificuldade}' apareceu ${count}x em ${a.periodo_tendencia_dias} dias`);
    }
    if (atual > 0 && anterior > 0) {
      const queda = Math.round((1 - atual / anterior) * 100);
      if (queda >= 30) sinais.push(`queda de ${queda}% em interações vs período anterior`);
    }

    const recent = interactions.slice(0, a.n_recent_interactions).map(i => ({
      timestamp: i.timestamp,
      channel: i.channel,
      summary: (i as any).summary,
      dificuldade: (i as any).dificuldade ?? null,
      encaminhamento: (i as any).encaminhamento ?? null,
      contexto_lead: (i as any).contexto_lead ?? null,
    }));

    return {
      broker: { ...fm, entity_name: fm.entity_name ?? a.broker_name },
      pendencias_abertas: pendenciasList,
      dificuldades_recorrentes: Array.isArray(fm.dificuldades_recorrentes) ? fm.dificuldades_recorrentes : [],
      recent_interactions: recent,
      dias_desde_ultima_interacao: diasDesdeUltima,
      total_interacoes_periodo_atual: atual,
      total_interacoes_periodo_anterior: anterior,
      dificuldades_repetidas: dificuldadesRepetidas,
      sinais_de_risco: sinais,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Broker '${(args as any).broker_name}': ${v.sinais_de_risco.length} sinais de risco, ${v.total_interacoes_periodo_atual} interações nos últimos ${(args as any).periodo_tendencia_dias ?? 28}d`);
}

// ─── list_brokers_needing_attention ──────────────────────────────────────────

export async function getBrokerOperationalSummary(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const parsedArgs = GetBrokerOperationalSummarySchema.safeParse(args);
  if (!parsedArgs.success) return await getBrokerOperationalSummaryLegacy(args, ctx);
  const a = parsedArgs.data;
  const { slug, rel } = entityPathForName(a.broker_name, 'broker_name');
  const safe = safeJoin(ctx.vaultRoot, rel);
  if (!await statFile(safe)) return await getBrokerOperationalSummaryLegacy(args, ctx);

  const r = await tryToolBody(async () => {
    const { content } = await readFileAtomic(safe);
    const parsed = parseFrontmatter(content);
    const body = parseBrokerBody(parsed.body);
    const interactions = await journalInteractionsForEntity(ctx, a.as_agent, rel, slug, undefined, 'desc', undefined);
    const nowMs = Date.now();
    const periodMs = a.periodo_tendencia_dias * 86400_000;
    const atualStartMs = nowMs - periodMs;
    const anteriorStartMs = nowMs - 2 * periodMs;
    const parseTs = (ts: string): number => Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + ':00Z');

    let diasDesdeUltima: number | null = null;
    if (interactions.length > 0) {
      const lastMs = parseTs(interactions[0].timestamp);
      if (!Number.isNaN(lastMs)) diasDesdeUltima = Math.floor((nowMs - lastMs) / 86400_000);
    }

    let atual = 0;
    let anterior = 0;
    const difCounts = new Map<string, number>();
    for (const i of interactions) {
      const ms = parseTs(i.timestamp);
      if (Number.isNaN(ms)) continue;
      if (ms >= atualStartMs) {
        atual++;
        if (typeof i.dificuldade === 'string' && i.dificuldade.trim() !== '') {
          difCounts.set(i.dificuldade, (difCounts.get(i.dificuldade) ?? 0) + 1);
        }
      } else if (ms >= anteriorStartMs) {
        anterior++;
      }
    }
    const dificuldadesRepetidas: DificuldadeCount[] = [];
    for (const [dificuldade, count] of difCounts) if (count >= 2) dificuldadesRepetidas.push({ dificuldade, count });

    const fm = parsed.frontmatter ?? {};
    const pendenciasList: string[] = Array.isArray(fm.pendencias_abertas) ? fm.pendencias_abertas : [];
    const sinais: string[] = [];
    if (diasDesdeUltima !== null && diasDesdeUltima > 7) sinais.push(`sem interacao ha ${diasDesdeUltima} dias`);
    if (pendenciasList.length > 0) sinais.push(`${pendenciasList.length} pendencia(s) aberta(s)`);
    for (const { dificuldade, count } of dificuldadesRepetidas) sinais.push(`dificuldade '${dificuldade}' apareceu ${count}x em ${a.periodo_tendencia_dias} dias`);

    return {
      broker: { ...fm, entity_name: fm.name ?? fm.entity_name ?? a.broker_name, path: rel },
      pendencias_abertas: pendenciasList,
      dificuldades_recorrentes: Array.isArray(fm.dificuldades_recorrentes) ? fm.dificuldades_recorrentes : [],
      recent_interactions: interactions.slice(0, a.n_recent_interactions),
      dias_desde_ultima_interacao: diasDesdeUltima,
      total_interacoes_periodo_atual: atual,
      total_interacoes_periodo_anterior: anterior,
      dificuldades_repetidas: dificuldadesRepetidas,
      sinais_de_risco: sinais,
      resumo: body.headers.resumo,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Broker '${(args as any).broker_name}': ${v.sinais_de_risco.length} sinais de risco, ${v.total_interacoes_periodo_atual} interacoes`);
}

export const ListBrokersNeedingAttentionSchema = z.object({
  as_agent: z.string().min(1),
  since: z.string().optional().default('7d'),
  risk_levels: z.array(z.string()).optional().default(['atencao', 'risco', 'critico']),
  equipes: z.array(z.string()).optional(),
  min_pendencias: z.number().int().nonnegative().optional(),
  min_dificuldades_repetidas: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional().default(20),
  order: z.enum(['priority', 'alphabetical', 'last_interaction']).optional().default('priority'),
});

const NIVEL_ATENCAO_WEIGHT: Record<string, number> = { normal: 0, atencao: 5, risco: 15, critico: 30 };

export async function listBrokersNeedingAttention(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ListBrokersNeedingAttentionSchema.parse(args);
    const nowMs = Date.now();
    // Validate since format (throws INVALID_RELATIVE_TIME on bad input)
    const sinceMs = parseRelativeOrIsoSince(a.since, nowMs);
    const inactivityThresholdDays = Math.floor((nowMs - sinceMs) / 86400_000);

    const riskFilter = new Set(a.risk_levels);
    const equipesFilter = a.equipes ? new Set(a.equipes) : null;
    const brokerPrefix = `_agents/${a.as_agent}/broker/`;

    const candidates: any[] = [];
    const brokerEntries = new Map<string, any>();
    for (const e of ctx.index.byOwner(a.as_agent)) brokerEntries.set(e.path, e);
    for (const e of ctx.index.allEntries()) {
      if (e.path.startsWith('_entities/') && e.frontmatter?.author_agent === a.as_agent) brokerEntries.set(e.path, e);
    }
    for (const e of brokerEntries.values()) {
      const isLegacyBrokerPath = e.path.startsWith(brokerPrefix) && e.path.endsWith('.md');
      const isV1BrokerPath = e.path.startsWith('_entities/') && e.path.endsWith('.md');
      if (!isLegacyBrokerPath && !isV1BrokerPath) continue;
      const fm = e.frontmatter ?? {};
      if (fm.entity_type !== 'broker') continue;

      const nivel = typeof fm.nivel_atencao === 'string' ? fm.nivel_atencao : 'normal';
      if (!riskFilter.has(nivel)) continue;
      const equipe = typeof fm.equipe === 'string' ? fm.equipe : null;
      if (equipesFilter && (!equipe || !equipesFilter.has(equipe))) continue;

      const pendencias: string[] = Array.isArray(fm.pendencias_abertas) ? fm.pendencias_abertas : [];
      if (a.min_pendencias !== undefined && pendencias.length < a.min_pendencias) continue;

      // Parse body to compute dias_desde_ultima_interacao + dificuldades_repetidas_count (current window)
      let diasDesdeUltima: number | null = null;
      let dificuldadesRepetidasCount = 0;
      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, e.path))); }
      catch { continue; }
      try {
        const parsed = parseFrontmatter(content);
        const body = parseBrokerBody(parsed.body);
        const ints = body.interactions.slice().sort((x, y) => y.timestamp.localeCompare(x.timestamp));
        if (ints.length > 0) {
          const lastMs = Date.parse(ints[0].timestamp.replace(' ', 'T') + ':00Z');
          if (!isNaN(lastMs)) diasDesdeUltima = Math.floor((nowMs - lastMs) / 86400_000);
        }
        // dificuldades repetidas in the inactivity window (last inactivityThresholdDays days)
        const windowStartMs = nowMs - inactivityThresholdDays * 86400_000;
        const difCounts = new Map<string, number>();
        for (const i of ints) {
          const ms = Date.parse(i.timestamp.replace(' ', 'T') + ':00Z');
          if (isNaN(ms) || ms < windowStartMs) continue;
          const d = (i as any).dificuldade;
          if (typeof d === 'string' && d.trim() !== '') difCounts.set(d, (difCounts.get(d) ?? 0) + 1);
        }
        for (const c of difCounts.values()) if (c >= 2) dificuldadesRepetidasCount++;
      } catch { /* keep null/0 on parse errors */ }

      if (a.min_dificuldades_repetidas !== undefined && dificuldadesRepetidasCount < a.min_dificuldades_repetidas) continue;

      // since filter: "inactivity AT LEAST sinceMs ago". diasDesdeUltima null → broker with no interactions passes.
      if (diasDesdeUltima !== null) {
        const lastInteractionMs = nowMs - diasDesdeUltima * 86400_000;
        if (lastInteractionMs > sinceMs) continue;
      }

      const priorityScore =
        (diasDesdeUltima ?? 0) +
        pendencias.length * 3 +
        dificuldadesRepetidasCount * 2 +
        (NIVEL_ATENCAO_WEIGHT[nivel] ?? 0);

      candidates.push({
        broker_name: fm.entity_name ?? '',
        nivel_atencao: nivel,
        equipe,
        dias_desde_ultima_interacao: diasDesdeUltima,
        pendencias_count: pendencias.length,
        dificuldades_repetidas_count: dificuldadesRepetidasCount,
        ultima_acao_recomendada: typeof fm.ultima_acao_recomendada === 'string' ? fm.ultima_acao_recomendada : null,
        priority_score: priorityScore,
      });
    }

    // Order
    if (a.order === 'alphabetical') {
      candidates.sort((x, y) => x.broker_name.localeCompare(y.broker_name));
    } else if (a.order === 'last_interaction') {
      candidates.sort((x, y) => (y.dias_desde_ultima_interacao ?? 0) - (x.dias_desde_ultima_interacao ?? 0));
    } else {
      candidates.sort((x, y) => y.priority_score - x.priority_score);
    }
    const total = candidates.length;
    const brokers = candidates.slice(0, a.limit);
    return { brokers, total };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Brokers needing attention: ${v.brokers.length}/${v.total} (order=${(args as any).order ?? 'priority'})`);
}

// ─── upsert_financial_snapshot + read_financial_series ───────────────────────

const periodReFinancial = /^\d{4}-(0[1-9]|1[0-2])$/;

export const UpsertFinancialSnapshotSchema = z.object({
  as_agent: z.string().min(1),
  period: z.string(),
  caixa: z.string().optional(),
  receita: z.string().optional(),
  despesa: z.string().optional(),
  alertas: z.array(z.string()).optional(),
  contexto: z.string().optional(),
  caixa_resumo: z.string().optional(),
  receita_resumo: z.string().optional(),
  despesa_resumo: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export async function upsertFinancialSnapshot(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = UpsertFinancialSnapshotSchema.parse(args);
    if (!periodReFinancial.test(a.period)) {
      throw new McpError('INVALID_PERIOD', `period must be YYYY-MM (got '${a.period}')`);
    }
    for (const key of ['caixa_resumo', 'receita_resumo', 'despesa_resumo'] as const) {
      const v = (a as any)[key];
      if (typeof v === 'string' && v.includes('\n')) {
        throw new McpError('INVALID_FRONTMATTER', `${key} must be one line (no newline)`);
      }
    }

    const rel = `_shared/financials/${a.period}/${a.as_agent}.md`;
    await ownerCheck(ctx, rel, a.as_agent);
    const safe = safeJoin(ctx.vaultRoot, rel);
    const existing = await statFile(safe);

    // Load prior sections if update
    let priorFm: Record<string, any> | null = null;
    let priorSections: FinancialSections = { caixa: null, receita: null, despesa: null, alertas: null, contexto: null };
    if (existing) {
      const { content } = await readFileAtomic(safe);
      const parsed = parseFrontmatter(content);
      priorFm = parsed.frontmatter;
      priorSections = parseFinancialBody(parsed.body);
    }

    // Merge: undefined → keep prior; provided → override
    const merged: FinancialSections = {
      caixa:    a.caixa    !== undefined ? (a.caixa    === '' ? null : a.caixa)    : priorSections.caixa,
      receita:  a.receita  !== undefined ? (a.receita  === '' ? null : a.receita)  : priorSections.receita,
      despesa:  a.despesa  !== undefined ? (a.despesa  === '' ? null : a.despesa)  : priorSections.despesa,
      alertas:  a.alertas  !== undefined ? a.alertas                                : priorSections.alertas,
      contexto: a.contexto !== undefined ? (a.contexto === '' ? null : a.contexto) : priorSections.contexto,
    };

    // Auto-extract *_resumo from merged body if not explicitly passed; else use prior fm
    const caixaResumo = a.caixa_resumo !== undefined
      ? (a.caixa_resumo === '' ? null : a.caixa_resumo)
      : (a.caixa !== undefined
          ? extractFirstLine(merged.caixa)
          : (priorFm?.caixa_resumo ?? extractFirstLine(merged.caixa)));
    const receitaResumo = a.receita_resumo !== undefined
      ? (a.receita_resumo === '' ? null : a.receita_resumo)
      : (a.receita !== undefined
          ? extractFirstLine(merged.receita)
          : (priorFm?.receita_resumo ?? extractFirstLine(merged.receita)));
    const despesaResumo = a.despesa_resumo !== undefined
      ? (a.despesa_resumo === '' ? null : a.despesa_resumo)
      : (a.despesa !== undefined
          ? extractFirstLine(merged.despesa)
          : (priorFm?.despesa_resumo ?? extractFirstLine(merged.despesa)));
    const alertasCount = merged.alertas !== null ? merged.alertas.length : 0;

    const fm: Record<string, any> = {
      type: 'financial-snapshot',
      owner: a.as_agent,
      created: priorFm?.created ?? today(),
      updated: today(),
      tags: a.tags ?? priorFm?.tags ?? [],
      period: a.period,
      alertas_count: alertasCount,
    };
    if (caixaResumo   !== null) fm.caixa_resumo   = caixaResumo;
    if (receitaResumo !== null) fm.receita_resumo = receitaResumo;
    if (despesaResumo !== null) fm.despesa_resumo = despesaResumo;

    const body = serializeFinancialBody(merged);
    await lockPathsForWrite(ctx, [rel]);
    await writeFileAtomic(safe, serializeFrontmatter(fm, body));
    await ctx.index.updateAfterWrite(rel);
    setLastWriteTs();
    log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_financial_snapshot', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
    await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_financial_snapshot: ${rel}`, as_agent: a.as_agent, tool: 'upsert_financial_snapshot' });
    return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const ReadFinancialSeriesSchema = z.object({
  as_agent: z.string().min(1),
  periods: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().optional().default(12),
  order: z.enum(['desc', 'asc']).optional().default('desc'),
});

export async function readFinancialSeries(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = ReadFinancialSeriesSchema.parse(args);

    // Validate period-shaped filters when provided (since/until or explicit periods)
    const validatePeriodStr = (p: string, field: string) => {
      if (!periodReFinancial.test(p)) {
        throw new McpError('INVALID_PERIOD', `${field} must be YYYY-MM (got '${p}')`);
      }
    };
    if (a.since)  validatePeriodStr(a.since,  'since');
    if (a.until)  validatePeriodStr(a.until,  'until');
    if (a.periods) for (const p of a.periods) validatePeriodStr(p, 'periods[]');
    if (a.since && a.until && a.since > a.until) {
      throw new McpError('INVALID_TIME_RANGE', `since (${a.since}) must be <= until (${a.until})`);
    }

    // Mode (a): explicit periods[] → each must exist or SNAPSHOT_NOT_FOUND
    let selectedPeriods: string[];
    if (a.periods) {
      const missing: string[] = [];
      const found: string[] = [];
      for (const p of a.periods) {
        const rel = `_shared/financials/${p}/${a.as_agent}.md`;
        if (ctx.index.get(rel)) found.push(p); else missing.push(p);
      }
      if (missing.length > 0) {
        throw new McpError('SNAPSHOT_NOT_FOUND', `Missing snapshots for ${a.as_agent}: ${missing.join(', ')}`);
      }
      selectedPeriods = found;
      if (a.since)  selectedPeriods = selectedPeriods.filter(p => p >= a.since!);
      if (a.until)  selectedPeriods = selectedPeriods.filter(p => p <= a.until!);
    } else {
      // Mode (b): scan index for all financials for as_agent; filter by since/until
      const prefix = '_shared/financials/';
      const suffix = `/${a.as_agent}.md`;
      const all: string[] = [];
      for (const e of ctx.index.allEntries()) {
        if (!e.path.startsWith(prefix) || !e.path.endsWith(suffix)) continue;
        const period = e.path.slice(prefix.length, e.path.length - suffix.length);
        if (!periodReFinancial.test(period)) continue;
        all.push(period);
      }
      selectedPeriods = all;
      if (a.since) selectedPeriods = selectedPeriods.filter(p => p >= a.since!);
      if (a.until) selectedPeriods = selectedPeriods.filter(p => p <= a.until!);
    }

    // Sort lexicographic + order
    selectedPeriods.sort();
    if (a.order === 'desc') selectedPeriods.reverse();
    selectedPeriods = selectedPeriods.slice(0, a.limit);

    // Parse each snapshot
    const snapshots: any[] = [];
    for (const period of selectedPeriods) {
      const rel = `_shared/financials/${period}/${a.as_agent}.md`;
      let content: string;
      try { ({ content } = await readFileAtomic(safeJoin(ctx.vaultRoot, rel))); }
      catch { continue; }
      const parsed = parseFrontmatter(content);
      const sections = parseFinancialBody(parsed.body);
      snapshots.push({
        period,
        frontmatter: parsed.frontmatter,
        caixa: sections.caixa,
        receita: sections.receita,
        despesa: sections.despesa,
        alertas: sections.alertas,
        contexto: sections.contexto,
      });
    }

    return { snapshots };
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as any;
  return ok(v, `Financial series for ${(args as any).as_agent}: ${v.snapshots.length} snapshot(s)`);
}

// ─── update_hub / upsert_runbook / upsert_hub ───────────────────────────────

export const UpdateHubSchema = z.object({
  as_agent: z.string().min(1),
  slug: z.string().regex(KEBAB_SEG, 'slug must be kebab single-segment'),
  title: z.string().min(1),
  status: EntityStatusSchema.optional(),
  source: EntitySourceSchema.optional(),
  tags: z.array(z.string()).optional(),
  scope: z.string().min(1).optional(),
  maintainer: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  related: EntityLinksSchema.optional(),
});

type UpdateHubArgs = z.infer<typeof UpdateHubSchema>;

interface UpsertMarkdownResult {
  path: string;
  created_or_updated: 'created' | 'updated';
}

interface FenceState {
  marker: '`' | '~';
  length: number;
}

function parseFence(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const run = match[1];
  return { marker: run[0] as '`' | '~', length: run.length };
}

function updateFenceState(line: string, current: FenceState | null): FenceState | null {
  const next = parseFence(line);
  if (!next) return current;
  if (!current) return next;
  if (next.marker === current.marker && next.length >= current.length) return null;
  return current;
}

function sectionLines(heading: string, content: string): string[] {
  const trimmed = content.trimEnd();
  return trimmed ? [`## ${heading}`, '', ...trimmed.split('\n')] : [`## ${heading}`, ''];
}

function setMarkdownSection(body: string, heading: string, content: string): string {
  const lines = body.trimEnd().split('\n');
  const target = `## ${heading}`;
  let fence: FenceState | null = null;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence) {
      const normalized = line.trimEnd();
      if (normalized === target) {
        start = i;
      } else if (start !== -1 && /^##\s+/.test(normalized)) {
        end = i;
        break;
      }
    }
    fence = updateFenceState(line, fence);
  }

  const nextSection = sectionLines(heading, content);
  if (start === -1) {
    const trimmed = body.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${nextSection.join('\n')}\n`;
  }

  if (end < lines.length) nextSection.push('');
  return [...lines.slice(0, start), ...nextSection, ...lines.slice(end)].join('\n').trimEnd() + '\n';
}

function renderRelated(related: string[]): string {
  return related.map(link => `- ${link}`).join('\n');
}

async function updateHubValue(args: unknown, ctx: ToolCtx): Promise<UpsertMarkdownResult> {
  const a = UpdateHubSchema.parse(args);
  const rel = `_hubs/${a.slug}.md`;
  await ownerCheck(ctx, rel, a.as_agent);
  const safe = safeJoin(ctx.vaultRoot, rel);

  await lockPathsForWrite(ctx, [rel]);
  const existing = await statFile(safe);
  let priorFm: Record<string, any> | null = null;
  let body = `# ${a.title}\n`;
  if (existing) {
    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    priorFm = parsed.frontmatter;
    body = parsed.body;
  }

  const writeDate = today();
  const fm: Record<string, any> = {
    ...(priorFm ?? {}),
    schema_version: 1,
    type: 'hub',
    status: a.status ?? priorFm?.status ?? 'active',
    created: priorFm?.created ?? writeDate,
    updated: writeDate,
    source: a.source ?? priorFm?.source ?? config.defaultAgentSource,
    tags: a.tags ?? priorFm?.tags ?? [],
    author_agent: a.as_agent,
    title: a.title,
    scope: a.scope ?? priorFm?.scope ?? 'hub',
    maintainer: a.maintainer ?? priorFm?.maintainer ?? a.as_agent,
  };
  if (a.summary !== undefined) fm.summary = a.summary;
  else if (priorFm?.summary !== undefined) fm.summary = priorFm.summary;
  if (a.related !== undefined) fm.related = a.related;
  else if (priorFm?.related !== undefined) fm.related = priorFm.related;

  if (a.summary !== undefined) body = setMarkdownSection(body, 'Summary', a.summary);
  if (a.related !== undefined) body = setMarkdownSection(body, 'Related', renderRelated(a.related));

  const assembled = serializeFrontmatter(fm, body);
  parseFrontmatter(assembled);
  await writeFileAtomic(safe, assembled);
  await ctx.index.updateAfterWrite(rel);
  setLastWriteTs();
  log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'update_hub', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
  await enqueueWriteJob(ctx, { path: rel, message: `[mcp] update_hub: ${rel}`, as_agent: a.as_agent, tool: 'update_hub' });
  return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
}

export async function updateHub(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    return await updateHubValue(args, ctx);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const UpsertRunbookSchema = z.object({
  as_agent: z.string().min(1),
  slug: z.string().regex(KEBAB_SEG, 'slug must be kebab single-segment'),
  title: z.string().min(1),
  content: z.string().optional(),
  body: z.string().optional(),
  status: EntityStatusSchema.optional(),
  source: EntitySourceSchema.optional(),
  tags: z.array(z.string()).optional(),
  procedure_owner: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
});

async function upsertRunbookValue(args: unknown, ctx: ToolCtx): Promise<UpsertMarkdownResult> {
  const a = UpsertRunbookSchema.parse(args);
  if (a.as_agent === 'reno' && !a.slug.startsWith('reno-')) {
    throw new McpError('ROUTING_VIOLATION', `Reno can only write runbook slugs starting with 'reno-': ${a.slug}`);
  }

  const rel = `_runbooks/${a.slug}.md`;
  await ownerCheck(ctx, rel, a.as_agent);
  const safe = safeJoin(ctx.vaultRoot, rel);

  await lockPathsForWrite(ctx, [rel]);
  const existing = await statFile(safe);
  let priorFm: Record<string, any> | null = null;
  let priorBody = '';
  if (existing) {
    const raw = (await readFileAtomic(safe)).content;
    const parsed = parseFrontmatter(raw);
    priorFm = parsed.frontmatter;
    priorBody = parsed.body;
  }

  const writeDate = today();
  const fm: Record<string, any> = {
    ...(priorFm ?? {}),
    schema_version: 1,
    type: 'runbook',
    status: a.status ?? priorFm?.status ?? 'active',
    created: priorFm?.created ?? writeDate,
    updated: writeDate,
    source: a.source ?? priorFm?.source ?? config.defaultAgentSource,
    tags: a.tags ?? priorFm?.tags ?? [],
    author_agent: a.as_agent,
    title: a.title,
    procedure_owner: a.procedure_owner ?? priorFm?.procedure_owner ?? a.as_agent,
    trigger: a.trigger ?? priorFm?.trigger ?? 'manual',
  };

  const body = (a.content ?? a.body ?? priorBody) || `# ${a.title}\n\n## Procedure\n\n`;
  const assembled = serializeFrontmatter(fm, body);
  parseFrontmatter(assembled);
  assertRenoResolvedWikilinkOnCreate(ctx, {
    rel,
    content: assembled,
    frontmatter: fm,
    actor: a.as_agent,
    existing: Boolean(existing),
  });
  await writeFileAtomic(safe, assembled);
  await ctx.index.updateAfterWrite(rel);
  setLastWriteTs();
  log({ timestamp: new Date().toISOString(), level: 'audit', audit: true, tool: 'upsert_runbook', as_agent: a.as_agent, path: rel, action: existing ? 'update' : 'create', outcome: 'ok' });
  await enqueueWriteJob(ctx, { path: rel, message: `[mcp] upsert_runbook: ${rel}`, as_agent: a.as_agent, tool: 'upsert_runbook' });
  return { path: rel, created_or_updated: existing ? 'updated' : 'created' };
}

export async function upsertRunbook(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    return await upsertRunbookValue(args, ctx);
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}

export const UpsertHubSchema = z.object({
  as_agent: z.string().min(1),
  hub_type: z.enum(['empreendimento', 'broker', 'fonte', 'regiao']),
  slug: z.string().regex(KEBAB_SEG, 'slug must be kebab single-segment').optional(),
  display_name: z.string().min(1),
  status: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  body: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

function compatibleV1Status(status: string | undefined): z.infer<typeof EntityStatusSchema> | undefined {
  const parsed = EntityStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : undefined;
}

export async function upsertHub(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  if (config.legacyToolMode === 'error') {
    return new McpError(
      'DEPRECATED_TOOL',
      'upsert_hub is deprecated; use update_hub.',
      'Use update_hub to create or update Schema v1 hubs in _hubs/.',
    ).toMcpResponse();
  }

  const r = await tryToolBody(async () => {
    const hasTags = rawHasOwn(args, 'tags');
    const a = UpsertHubSchema.parse(args);
    const slug = a.slug ?? toKebabSlug(a.display_name);
    if (slug === '') throw new McpError('INVALID_FILENAME', `display_name produces empty slug: '${a.display_name}'`);

    const status = compatibleV1Status(a.status);
    const redirectedArgs: UpdateHubArgs = {
      as_agent: a.as_agent,
      slug,
      title: a.display_name,
      ...(hasTags ? { tags: a.tags ?? [] } : {}),
      ...(a.body !== undefined ? { summary: a.body } : {}),
      ...(status ? { status } : {}),
    };
    const updated = await updateHubValue(redirectedArgs, ctx);
    return {
      ...updated,
      deprecated: true,
      legacy_tool: 'upsert_hub',
      redirected_to: 'update_hub',
      legacy_tool_mode: config.legacyToolMode,
      new_path: updated.path,
    };
  });
  if (!r.ok) return r.err.toMcpResponse();
  return ok(r.value as any, `${(r.value as any).created_or_updated} ${(r.value as any).path}`);
}
