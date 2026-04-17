// src/vault/financial.ts

export interface FinancialSections {
  caixa: string | null;
  receita: string | null;
  despesa: string | null;
  alertas: string[] | null;
  contexto: string | null;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;

function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function parseFinancialBody(body: string): FinancialSections {
  const lines = body.split('\n');
  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      current = normalizeKey(m[1]);
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

  const alertasLines = sections['alertas'];
  let alertas: string[] | null = null;
  if (alertasLines) {
    alertas = alertasLines
      .map(l => l.match(/^-\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1].trim());
  }

  return {
    caixa: getText('caixa'),
    receita: getText('receita'),
    despesa: getText('despesa'),
    alertas,
    contexto: getText('contexto adicional'),
  };
}

export function extractFirstLine(section: string | null): string | null {
  if (section === null) return null;
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return null;
}

export function serializeFinancialBody(sections: FinancialSections): string {
  const parts: string[] = [];
  if (sections.caixa !== null)    parts.push(`## Caixa\n${sections.caixa}`);
  if (sections.receita !== null)  parts.push(`## Receita\n${sections.receita}`);
  if (sections.despesa !== null)  parts.push(`## Despesa\n${sections.despesa}`);
  if (sections.alertas !== null) {
    const items = sections.alertas.map(a => `- ${a}`).join('\n');
    parts.push(`## Alertas${items ? '\n' + items : ''}`);
  }
  if (sections.contexto !== null) parts.push(`## Contexto adicional\n${sections.contexto}`);
  return parts.join('\n\n') + (parts.length > 0 ? '\n' : '');
}
