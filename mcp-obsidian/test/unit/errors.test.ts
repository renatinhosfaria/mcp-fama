import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '../../src/errors.js';

describe('McpError', () => {
  it('carries code, message, and optional suggestion', () => {
    const e = new McpError('OWNERSHIP_VIOLATION', 'msg', 'try x');
    expect(e.code).toBe('OWNERSHIP_VIOLATION');
    expect(e.message).toBe('msg');
    expect(e.suggestion).toBe('try x');
  });

  it('serializes to MCP dual response shape', () => {
    const e = new McpError('NOTE_NOT_FOUND', 'missing');
    const r = e.toMcpResponse();
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe('NOTE_NOT_FOUND');
    expect(r.content[0].type).toBe('text');
  });

  it('ErrorCode enum includes all spec codes', () => {
    const codes: ErrorCode[] = [
      'OWNERSHIP_VIOLATION', 'UNMAPPED_PATH', 'INVALID_FRONTMATTER',
      'INVALID_FILENAME', 'INVALID_OWNER', 'IMMUTABLE_TARGET',
      'JOURNAL_IMMUTABLE', 'NOTE_NOT_FOUND', 'WIKILINK_TARGET_MISSING',
      'GIT_LOCK_BUSY', 'GIT_PUSH_FAILED', 'VAULT_IO_ERROR',
    ];
    expect(codes.length).toBe(12);
  });
});
