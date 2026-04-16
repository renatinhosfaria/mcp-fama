export type ErrorCode =
  | 'OWNERSHIP_VIOLATION'
  | 'UNMAPPED_PATH'
  | 'INVALID_FRONTMATTER'
  | 'INVALID_FILENAME'
  | 'INVALID_OWNER'
  | 'IMMUTABLE_TARGET'
  | 'JOURNAL_IMMUTABLE'
  | 'NOTE_NOT_FOUND'
  | 'WIKILINK_TARGET_MISSING'
  | 'GIT_LOCK_BUSY'
  | 'GIT_PUSH_FAILED'
  | 'VAULT_IO_ERROR';

export interface McpToolResponse {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

export class McpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'McpError';
  }

  toMcpResponse(): McpToolResponse {
    return {
      isError: true,
      content: [{ type: 'text', text: `[${this.code}] ${this.message}${this.suggestion ? ` — ${this.suggestion}` : ''}` }],
      structuredContent: { error: { code: this.code, message: this.message, suggestion: this.suggestion } },
    };
  }
}
