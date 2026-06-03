export interface IndexPolicy {
  vector: boolean;
  graph: boolean;
}

const VECTOR_AND_GRAPH_FOLDERS = new Set(['_entities', '_hubs', '_decisions', '_runbooks', '_journal']);

const DEFAULT_META_VECTOR_ALLOWLIST = [
  '_meta/schema.md',
  '_meta/retrieval-policy.md',
  '_meta/pii-redaction-policy.md',
  '_meta/embedding-state.md',
  '_meta/golden-queries.md',
  '_meta/index.md',
  '_meta/README.md',
];

function topFolder(rel: string): string {
  return normalizeVaultPath(rel).split('/')[0] ?? '';
}

function normalizeVaultPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function metaVectorAllowlist(): Set<string> {
  const configured = process.env.SEMANTIC_META_VECTOR_ALLOWLIST;
  const values = configured !== undefined
    ? configured.split(',').map((item) => normalizeVaultPath(item.trim())).filter(Boolean)
    : DEFAULT_META_VECTOR_ALLOWLIST;
  return new Set(values);
}

function folderPolicy(rel: string): IndexPolicy {
  const normalized = normalizeVaultPath(rel);
  if (metaVectorAllowlist().has(normalized)) return { vector: true, graph: true };

  const folder = topFolder(normalized);
  if (VECTOR_AND_GRAPH_FOLDERS.has(folder)) return { vector: true, graph: true };
  return { vector: false, graph: false };
}

export function computeIndexPolicy(rel: string, fm: Record<string, any> | null | undefined): IndexPolicy {
  const status = fm?.status;
  if (status === 'draft') return { vector: false, graph: false };
  if (status === 'superseded' || status === 'archived') return { vector: false, graph: true };
  return folderPolicy(rel);
}
