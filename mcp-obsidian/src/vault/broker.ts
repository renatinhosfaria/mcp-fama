// src/vault/broker.ts

export interface BrokerHeaders {
  resumo: string | null;
  comunicacao: string | null;
  padroes_atendimento: string | null;
  pendencias_abertas: string[] | null;
}

export interface BrokerInteraction {
  timestamp: string;
  channel: string;
  contexto_lead: string | null;
  summary: string;
  dificuldade: string | null;
  encaminhamento: string | null;
  tags: string[];
}

export interface MalformedBlock { line: number; reason: string; }

export interface BrokerBody {
  headers: BrokerHeaders;
  interactions: BrokerInteraction[];
  malformed_blocks: MalformedBlock[];
}

const HISTORY_DELIMITER = '## Histórico de interações';
const TIMESTAMP_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/;
const KV_RE = /^([A-Za-zÀ-ÿ ]+):\s*(.*)$/;

export function parseBrokerBody(body: string): BrokerBody {
  const lines = body.split('\n');
  const delimIdx = lines.findIndex(l => l.trim() === HISTORY_DELIMITER);
  const headerLines = delimIdx >= 0 ? lines.slice(0, delimIdx) : lines;
  const historyLines = delimIdx >= 0 ? lines.slice(delimIdx + 1) : [];

  const headers = parseHeaderSections(headerLines);
  const { interactions, malformed_blocks } = parseInteractionBlocks(historyLines, delimIdx + 2);
  return { headers, interactions, malformed_blocks };
}

function parseHeaderSections(lines: string[]): BrokerHeaders {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  const SECTION_RE = /^##\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) { current = m[1].toLowerCase(); sections[current] = []; continue; }
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
    comunicacao: getText('comunicação') ?? getText('comunicacao'),
    padroes_atendimento: getText('padrões de atendimento') ?? getText('padroes de atendimento'),
    pendencias_abertas: getList('pendências abertas') ?? getList('pendencias abertas'),
  };
}

function parseInteractionBlocks(lines: string[], lineOffset = 1): { interactions: BrokerInteraction[]; malformed_blocks: MalformedBlock[]; } {
  const interactions: BrokerInteraction[] = [];
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
      while (i < lines.length && !lines[i].startsWith('## ')) { fieldLines.push(lines[i]); i++; }
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

function fieldsToInteraction(timestamp: string, fieldLines: string[]): BrokerInteraction {
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
  const tags: string[] = kv['tags'] ? kv['tags'].split(/\s+/).filter(t => t.startsWith('#')) : [];
  return {
    timestamp,
    channel: kv['canal'],
    contexto_lead: kv['lead em contexto'] ?? null,
    summary: kv['resumo'],
    dificuldade: kv['dificuldade'] ?? null,
    encaminhamento: kv['encaminhamento'] ?? null,
    tags,
  };
}

export function serializeInteractionBlock(i: BrokerInteraction): string {
  const lines: string[] = [`## ${i.timestamp}`, `Canal: ${i.channel}`];
  if (i.contexto_lead) lines.push(`Lead em contexto: ${i.contexto_lead}`);
  lines.push(`Resumo: ${i.summary}`);
  if (i.dificuldade) lines.push(`Dificuldade: ${i.dificuldade}`);
  if (i.encaminhamento) lines.push(`Encaminhamento: ${i.encaminhamento}`);
  if (i.tags && i.tags.length > 0) lines.push(`Tags: ${i.tags.join(' ')}`);
  return lines.join('\n');
}

export function serializeBrokerBody(broker: BrokerBody): string {
  const parts: string[] = [];
  if (broker.headers.resumo !== null) parts.push(`## Resumo\n${broker.headers.resumo}`);
  if (broker.headers.comunicacao !== null) parts.push(`## Comunicação\n${broker.headers.comunicacao}`);
  if (broker.headers.padroes_atendimento !== null) parts.push(`## Padrões de atendimento\n${broker.headers.padroes_atendimento}`);
  if (broker.headers.pendencias_abertas !== null) parts.push(`## Pendências abertas\n${broker.headers.pendencias_abertas.map(o => `- ${o}`).join('\n')}`);
  parts.push(`## Histórico de interações`);
  for (const i of broker.interactions) parts.push(serializeInteractionBlock(i));
  return parts.join('\n\n') + '\n';
}
