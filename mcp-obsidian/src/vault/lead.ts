// src/vault/lead.ts

export interface LeadHeaders {
  resumo: string | null;
  interesse_atual: string | null;
  objecoes_ativas: string[] | null;
  proximo_passo: string | null;
}

export interface LeadInteraction {
  timestamp: string;       // YYYY-MM-DD HH:MM
  channel: string;
  origem: string | null;
  summary: string;
  objection: string | null;
  next_step: string | null;
  tags: string[];
}

export interface MalformedBlock {
  line: number;             // 1-indexed line of the `## ...` header
  reason: string;
}

export interface LeadBody {
  headers: LeadHeaders;
  interactions: LeadInteraction[];
  malformed_blocks: MalformedBlock[];
}

const HISTORY_DELIMITER = '## Histórico de interações';
const TIMESTAMP_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/;
const KV_RE = /^([A-Za-zÀ-ÿ ]+):\s*(.*)$/;

export function parseLeadBody(body: string): LeadBody {
  const lines = body.split('\n');
  const delimIdx = lines.findIndex(l => l.trim() === HISTORY_DELIMITER);

  const headerLines = delimIdx >= 0 ? lines.slice(0, delimIdx) : lines;
  const historyLines = delimIdx >= 0 ? lines.slice(delimIdx + 1) : [];

  const headers = parseHeaderSections(headerLines);
  const { interactions, malformed_blocks } = parseInteractionBlocks(historyLines, delimIdx + 2);
  return { headers, interactions, malformed_blocks };
}

function parseHeaderSections(lines: string[]): LeadHeaders {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  const SECTION_RE = /^##\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      current = m[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current !== null) sections[current].push(line);
  }
  const getText = (key: string): string | null => {
    const arr = sections[key];
    if (!arr) return null;
    const joined = arr.join('\n').trim();
    return joined === '' ? null : joined;
  };
  const getList = (key: string): string[] | null => {
    const arr = sections[key];
    if (!arr) return null;
    const items = arr
      .map(l => l.match(/^-\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1].trim());
    return items.length === 0 ? null : items;
  };
  return {
    resumo: getText('resumo'),
    interesse_atual: getText('interesse atual'),
    objecoes_ativas: getList('objeções ativas'),
    proximo_passo: getText('próximo passo'),
  };
}

export function parseInteractionBlocks(lines: string[], lineOffset = 1): { interactions: LeadInteraction[]; malformed_blocks: MalformedBlock[]; } {
  const interactions: LeadInteraction[] = [];
  const malformed_blocks: MalformedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    if (lines[i].startsWith('## ')) {
      const headerLineNum = lineOffset + i;
      const m = lines[i].match(TIMESTAMP_RE);
      if (!m) {
        malformed_blocks.push({ line: headerLineNum, reason: `header '${lines[i].trim()}' does not match timestamp pattern YYYY-MM-DD HH:MM` });
        i++;
        while (i < lines.length && !lines[i].startsWith('## ')) i++;
        continue;
      }
      const timestamp = m[1];
      const fieldLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('## ')) {
        fieldLines.push(lines[i]);
        i++;
      }
      try {
        const block = fieldsToInteraction(timestamp, fieldLines);
        interactions.push(block);
      } catch (e: any) {
        malformed_blocks.push({ line: headerLineNum, reason: e.message });
      }
      continue;
    }
    i++;
  }
  return { interactions, malformed_blocks };
}

function fieldsToInteraction(timestamp: string, fieldLines: string[]): LeadInteraction {
  const kv: Record<string, string> = {};
  for (const line of fieldLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const m = trimmed.match(KV_RE);
    if (!m) throw new Error(`malformed field line: '${trimmed}'`);
    const key = m[1].trim().toLowerCase();
    kv[key] = m[2].trim();
  }
  if (!kv['canal']) throw new Error(`missing required 'Canal:' field`);
  if (!kv['resumo']) throw new Error(`missing required 'Resumo:' field`);
  const tags: string[] = kv['tags']
    ? kv['tags'].split(/\s+/).filter(t => t.startsWith('#'))
    : [];
  return {
    timestamp,
    channel: kv['canal'],
    origem: kv['origem'] ?? null,
    summary: kv['resumo'],
    objection: kv['objeção'] ?? null,
    next_step: kv['próximo passo'] ?? null,
    tags,
  };
}

export function serializeInteractionBlock(i: LeadInteraction): string {
  const lines: string[] = [`## ${i.timestamp}`, `Canal: ${i.channel}`];
  if (i.origem) lines.push(`Origem: ${i.origem}`);
  lines.push(`Resumo: ${i.summary}`);
  if (i.objection) lines.push(`Objeção: ${i.objection}`);
  if (i.next_step) lines.push(`Próximo passo: ${i.next_step}`);
  if (i.tags && i.tags.length > 0) lines.push(`Tags: ${i.tags.join(' ')}`);
  return lines.join('\n');
}

export function serializeLeadBody(lead: LeadBody): string {
  const parts: string[] = [];
  if (lead.headers.resumo !== null) parts.push(`## Resumo\n${lead.headers.resumo}`);
  if (lead.headers.interesse_atual !== null) parts.push(`## Interesse atual\n${lead.headers.interesse_atual}`);
  if (lead.headers.objecoes_ativas !== null) parts.push(`## Objeções ativas\n${lead.headers.objecoes_ativas.map(o => `- ${o}`).join('\n')}`);
  if (lead.headers.proximo_passo !== null) parts.push(`## Próximo passo\n${lead.headers.proximo_passo}`);
  parts.push(`## Histórico de interações`);
  for (const i of lead.interactions) parts.push(serializeInteractionBlock(i));
  return parts.join('\n\n') + '\n';
}
