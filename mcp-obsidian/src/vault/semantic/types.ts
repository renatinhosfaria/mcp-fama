export interface SemanticChunk {
  path: string;
  chunk_index: number;
  heading: string;
  heading_path: string[];
  text: string;
  preview: string;
  content_hash: string;
}
