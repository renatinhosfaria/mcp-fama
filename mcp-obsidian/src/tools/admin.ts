import { z } from 'zod';
import { ToolCtx, tryToolBody, ok, ownerCheck } from './_shared.js';
import { readFileAtomic, writeFileAtomic, safeJoin, statFile } from '../vault/fs.js';
import { McpError, McpToolResponse } from '../errors.js';
import { setLastWriteTs } from '../last-write.js';
import { log } from '../middleware/logger.js';

function today(): string { return new Date().toISOString().slice(0, 10); }

const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const RESERVED_SLUGS = new Set(['renato', 'shared', 'agents', 'projects', 'infra']);

export const BootstrapAgentSchema = z.object({
  name: z.string().min(1),
  platform: z.enum(['paperclip', 'openclaw']),
  include_shared_goals: z.boolean().optional().default(false),
  include_shared_results: z.boolean().optional().default(false),
  include_financials: z.boolean().optional().default(false),
});

interface BootstrapResult {
  name: string;
  patterns_added: string[];
  files_created: string[];
  readme_updated: boolean;
  already_existed: boolean;
}

export async function bootstrapAgent(args: unknown, ctx: ToolCtx): Promise<McpToolResponse> {
  const r = await tryToolBody(async () => {
    const a = BootstrapAgentSchema.parse(args);
    const name = a.name;

    if (!SLUG_RE.test(name)) {
      throw new McpError('INVALID_FILENAME', `agent name '${name}' must match ${SLUG_RE.source}`);
    }
    if (RESERVED_SLUGS.has(name)) {
      throw new McpError('INVALID_OWNER', `agent name '${name}' is reserved`);
    }

    const agentsMdRel = '_shared/context/AGENTS.md';
    const agentsReadmeRel = '_agents/README.md';
    await ownerCheck(ctx, agentsMdRel, 'renato');
    await ownerCheck(ctx, agentsReadmeRel, 'renato');

    const agentsMdAbs = safeJoin(ctx.vaultRoot, agentsMdRel);
    const original = (await readFileAtomic(agentsMdAbs)).content;

    const desiredPatterns = buildDesiredPatterns(name, {
      goals: a.include_shared_goals,
      results: a.include_shared_results,
      financials: a.include_financials,
    });

    const { updated: newAgentsMd, added } = insertPatterns(original, name, desiredPatterns);
    const alreadyExisted = added.length === 0;

    if (newAgentsMd !== original) {
      await writeFileAtomic(agentsMdAbs, newAgentsMd);
      await ctx.index.updateAfterWrite(agentsMdRel);
    }

    const filesCreated: string[] = [];
    const date = today();

    const stubs: Array<{ rel: string; content: string }> = [
      { rel: `_agents/${name}/profile.md`,   content: stubProfile(name, date) },
      { rel: `_agents/${name}/decisions.md`, content: stubDecisions(name, date) },
      { rel: `_agents/${name}/README.md`,    content: stubReadme(name, date) },
    ];

    for (const s of stubs) {
      const abs = safeJoin(ctx.vaultRoot, s.rel);
      if (await statFile(abs)) continue;
      await writeFileAtomic(abs, s.content);
      await ctx.index.updateAfterWrite(s.rel);
      filesCreated.push(s.rel);
    }

    const readmeAbs = safeJoin(ctx.vaultRoot, agentsReadmeRel);
    const readmeBefore = (await readFileAtomic(readmeAbs)).content;
    const readmeAfter = insertAgentLink(readmeBefore, name, a.platform);
    const readmeUpdated = readmeAfter !== readmeBefore;
    if (readmeUpdated) {
      await writeFileAtomic(readmeAbs, readmeAfter);
      await ctx.index.updateAfterWrite(agentsReadmeRel);
    }

    setLastWriteTs();
    log({
      timestamp: new Date().toISOString(), level: 'audit', audit: true,
      tool: 'bootstrap_agent', as_agent: 'renato', path: `_agents/${name}/`,
      action: alreadyExisted && filesCreated.length === 0 && !readmeUpdated ? 'noop' : 'create',
      outcome: 'ok',
    });

    const result: BootstrapResult = {
      name,
      patterns_added: added,
      files_created: filesCreated,
      readme_updated: readmeUpdated,
      already_existed: alreadyExisted,
    };
    return result;
  });
  if (!r.ok) return r.err.toMcpResponse();
  const v = r.value as BootstrapResult;
  const summary = v.already_existed && v.files_created.length === 0 && !v.readme_updated
    ? `Agent '${v.name}' já estava completo (noop)`
    : `Agent '${v.name}': +${v.patterns_added.length} pattern(s), +${v.files_created.length} file(s), readme ${v.readme_updated ? 'updated' : 'ok'}`;
  return ok(v as any, summary);
}

function buildDesiredPatterns(name: string, opts: { goals: boolean; results: boolean; financials: boolean }): string[] {
  const patterns = [
    `_agents/${name}/**                => ${name}`,
    `_shared/context/*/${name}/**      => ${name}`,
  ];
  if (opts.goals)      patterns.push(`_shared/goals/*/${name}.md        => ${name}`);
  if (opts.results)    patterns.push(`_shared/results/*/${name}.md      => ${name}`);
  if (opts.financials) patterns.push(`_shared/financials/*/${name}.md   => ${name}`);
  return patterns;
}

function insertPatterns(src: string, name: string, desired: string[]): { updated: string; added: string[] } {
  const fenceRe = /```[a-z]*\n([\s\S]*?)```/i;
  const m = src.match(fenceRe);
  if (!m) throw new McpError('VAULT_IO_ERROR', 'AGENTS.md has no ownership fence block');
  const body = m[1];
  const existing = new Set<string>();
  for (const line of body.split('\n')) {
    const lm = line.match(/^([^\s=]+)\s*=>\s*([a-z][a-z0-9-]*)\s*$/);
    if (lm) existing.add(`${lm[1]}=>${lm[2]}`);
  }
  const added: string[] = [];
  const newLines: string[] = [];
  for (const p of desired) {
    const pm = p.match(/^([^\s=]+)\s*=>\s*([a-z][a-z0-9-]*)\s*$/);
    if (!pm) continue;
    const key = `${pm[1]}=>${pm[2]}`;
    if (existing.has(key)) continue;
    newLines.push(p);
    added.push(p);
  }
  if (added.length === 0) return { updated: src, added };

  const block = `\n${newLines.join('\n')}\n`;
  const newBody = body.replace(/\n*$/, '') + block;
  const updated = src.replace(fenceRe, '```\n' + newBody + '```');
  return { updated, added };
}

function insertAgentLink(src: string, name: string, platform: 'paperclip' | 'openclaw'): string {
  const heading = platform === 'paperclip' ? '## Paperclip (diretoria)' : '## OpenClaw (operacional)';
  const link = `- [[${name}/README|${name}]]`;
  const lines = src.split('\n');
  const hIdx = lines.findIndex(l => l.trim() === heading);
  if (hIdx < 0) return src;

  let endIdx = hIdx + 1;
  while (endIdx < lines.length && !lines[endIdx].startsWith('## ')) endIdx++;

  const sectionLines = lines.slice(hIdx + 1, endIdx);
  if (sectionLines.some(l => l.trim() === link)) return src;

  const itemLines = sectionLines
    .map((l, i) => ({ line: l, i }))
    .filter(x => x.line.startsWith('- [['));

  if (itemLines.length === 0) {
    const insertAt = hIdx + 1 + sectionLines.findIndex(l => l.trim() !== '');
    const actualInsert = insertAt > hIdx ? insertAt : hIdx + 2;
    lines.splice(actualInsert, 0, link);
    return lines.join('\n');
  }

  let insertAbsIdx = hIdx + 1 + itemLines[itemLines.length - 1].i + 1;
  for (const { line, i } of itemLines) {
    if (line.localeCompare(link) > 0) {
      insertAbsIdx = hIdx + 1 + i;
      break;
    }
  }
  lines.splice(insertAbsIdx, 0, link);
  return lines.join('\n');
}

function stubProfile(name: string, date: string): string {
  return `---
type: agent-profile
owner: ${name}
created: '${date}'
updated: '${date}'
tags: []
---
# Perfil — ${name}

<!-- Preencha na primeira interação: identidade, estilo de trabalho, preferências, auto-aprendizados. -->
`;
}

function stubDecisions(name: string, date: string): string {
  return `---
type: agent-decisions
owner: ${name}
created: '${date}'
updated: '${date}'
tags:
  - decisao
---
# Decisões — ${name}

<!-- Decisões mais recentes no topo. Use append_decision; nunca edite histórico. -->
`;
}

function stubReadme(name: string, date: string): string {
  return `---
type: agent-readme
owner: ${name}
created: '${date}'
updated: '${date}'
tags: []
---
# ${name}

<!-- Auto-documentação: o próprio agente escreve quem é e o que faz aqui, na primeira interação. -->
`;
}
