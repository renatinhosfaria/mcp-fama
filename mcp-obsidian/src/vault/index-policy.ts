export interface IndexPolicy {
  vector: boolean;
  graph: boolean;
}

const VECTOR_AND_GRAPH_FOLDERS = new Set(['_entities', '_hubs', '_decisions', '_runbooks', '_journal']);

function topFolder(rel: string): string {
  return rel.replace(/\\/g, '/').split('/')[0] ?? '';
}

function folderPolicy(rel: string): IndexPolicy {
  const folder = topFolder(rel);
  if (VECTOR_AND_GRAPH_FOLDERS.has(folder)) return { vector: true, graph: true };
  return { vector: false, graph: false };
}

export function computeIndexPolicy(rel: string, fm: Record<string, any> | null | undefined): IndexPolicy {
  const status = fm?.status;
  if (status === 'draft') return { vector: false, graph: false };
  if (status === 'superseded' || status === 'archived') return { vector: false, graph: true };
  return folderPolicy(rel);
}
