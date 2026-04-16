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
  | 'VAULT_IO_ERROR'
  | 'LEAD_NOT_FOUND'
  | 'MALFORMED_LEAD_BODY';

export interface McpToolResponse {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

export class McpError extends Error {
  public readonly rawMessage: string;

  constructor(
    public readonly code: ErrorCode,
    rawMessage: string,
    public readonly suggestion?: string,
  ) {
    super(`[${code}] ${rawMessage}`);
    this.name = 'McpError';
    this.rawMessage = rawMessage;
  }

  toMcpResponse(): McpToolResponse {
    return {
      isError: true,
      content: [{ type: 'text', text: `[${this.code}] ${this.rawMessage}${this.suggestion ? ` — ${this.suggestion}` : ''}` }],
      structuredContent: { error: { code: this.code, message: this.rawMessage, suggestion: this.suggestion } },
    };
  }
}
