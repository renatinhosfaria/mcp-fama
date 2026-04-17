// src/vault/regressao.ts

export interface RegressaoBody {
  agente_alvo: string | null;
  cenario: string | null;
  comportamento_esperado: string | null;
  comportamento_observado: string | null;
  severidade: string | null;
  status: string | null;
  categoria: string | null;
  historico: string[] | null;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;

function normalizeKey(raw: string): string {
  // lowercase + strip accents so "Cenário" → "cenario", "Histórico" → "historico"
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function parseRegressaoBody(body: string): RegressaoBody {
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
    agente_alvo: getText('agente alvo'),
    cenario: getText('cenario'),
    comportamento_esperado: getText('comportamento esperado'),
    comportamento_observado: getText('comportamento observado'),
    severidade: getText('severidade'),
    status: getText('status'),
    categoria: getText('categoria'),
    historico: getList('historico'),
  };
}
