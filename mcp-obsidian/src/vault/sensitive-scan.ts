import { readFileAtomic, safeJoin } from './fs.js';
import type { VaultIndex } from './index.js';

export const SENSITIVE_CATEGORIES = [
  'phone_like',
  'whatsapp_jid',
  'email',
  'cpf_like',
  'secret_keyword',
] as const;

export type SensitiveCategory = typeof SENSITIVE_CATEGORIES[number];

interface PatternDef {
  category: SensitiveCategory;
  re: RegExp;
  marker: string;
}

const PATTERNS: PatternDef[] = [
  { category: 'whatsapp_jid', re: /\b\d{10,18}@(s\.whatsapp\.net|lid)\b/gi, marker: '[WHATSAPP_JID_REDACTED]' },
  { category: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, marker: '[EMAIL_REDACTED]' },
  { category: 'cpf_like', re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, marker: '[CPF_REDACTED]' },
  { category: 'phone_like', re: /\b55\d{10,13}\b/g, marker: '[PHONE_REDACTED]' },
  { category: 'secret_keyword', re: /\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|SENHA)\b\s*[:=]\s*[^\s`"']+/gi, marker: '[SECRET_REDACTED]' },
];

export interface SensitiveScanOptions {
  path_prefix?: string;
  limit?: number;
  include_examples?: boolean;
}

export interface SensitiveScanResult {
  path_prefix: string | null;
  files_scanned: number;
  files_with_findings: number;
  counts: Record<SensitiveCategory, { occurrences: number; files: number }>;
  examples?: Array<{ category: SensitiveCategory; path: string; snippet: string }>;
}

function emptyCounts(): Record<SensitiveCategory, { occurrences: number; files: number }> {
  return Object.fromEntries(SENSITIVE_CATEGORIES.map(c => [c, { occurrences: 0, files: 0 }])) as Record<SensitiveCategory, { occurrences: number; files: number }>;
}

export function redactSensitiveText(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags), p.marker);
  }
  return out;
}

function snippetAround(content: string, index: number, length: number): string {
  const start = Math.max(0, index - 48);
  const end = Math.min(content.length, index + length + 48);
  return redactSensitiveText(content.slice(start, end)).replace(/\s+/g, ' ').trim();
}

export async function scanSensitiveIndex(
  vaultRoot: string,
  index: VaultIndex,
  options: SensitiveScanOptions = {},
): Promise<SensitiveScanResult> {
  const prefix = options.path_prefix?.replace(/\\/g, '/').replace(/^\/+/, '') ?? null;
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const includeExamples = options.include_examples ?? false;
  const counts = emptyCounts();
  const examples: Array<{ category: SensitiveCategory; path: string; snippet: string }> = [];
  const filesWithFindings = new Set<string>();
  let filesScanned = 0;

  const entries = index.allEntries()
    .filter(e => e.path.endsWith('.md'))
    .filter(e => !prefix || e.path === prefix || e.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const e of entries) {
    let content: string;
    try {
      ({ content } = await readFileAtomic(safeJoin(vaultRoot, e.path)));
    } catch {
      continue;
    }
    filesScanned += 1;
    const categoriesInFile = new Set<SensitiveCategory>();

    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = p.re.exec(content)) !== null) {
        counts[p.category].occurrences += 1;
        categoriesInFile.add(p.category);
        filesWithFindings.add(e.path);
        if (includeExamples && examples.length < limit) {
          examples.push({
            category: p.category,
            path: redactSensitiveText(e.path),
            snippet: snippetAround(content, match.index, match[0].length),
          });
        }
      }
    }

    for (const category of categoriesInFile) counts[category].files += 1;
  }

  return {
    path_prefix: prefix ? redactSensitiveText(prefix) : null,
    files_scanned: filesScanned,
    files_with_findings: filesWithFindings.size,
    counts,
    ...(includeExamples ? { examples } : {}),
  };
}
