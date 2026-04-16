// src/vault/fs.ts
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { McpError } from '../errors.js';

// ── C1: ASCII-fold + kebab-case + filename validators ────────────────────────

export function asciiFold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function toKebabSlug(s: string): string {
  return asciiFold(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/;
const JOURNAL_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

export function validateFilename(name: string): void {
  if (!FILENAME_RE.test(name)) {
    throw new McpError('INVALID_FILENAME', `[INVALID_FILENAME] Filename '${name}' does not match ${FILENAME_RE.source}`);
  }
}

export function validateJournalFilename(name: string): void {
  if (!JOURNAL_RE.test(name)) {
    throw new McpError('INVALID_FILENAME', `[INVALID_FILENAME] Journal filename '${name}' does not match ${JOURNAL_RE.source}`);
  }
}

// ── C2: safeJoin (path traversal guard) ─────────────────────────────────────

export function safeJoin(vaultRoot: string, relPath: string): string {
  if (!relPath || relPath.trim() === '') {
    throw new McpError('VAULT_IO_ERROR', '[VAULT_IO_ERROR] Empty path');
  }
  if (path.isAbsolute(relPath)) {
    throw new McpError('VAULT_IO_ERROR', `[VAULT_IO_ERROR] Absolute paths not allowed: ${relPath}`);
  }
  const root = path.resolve(vaultRoot);
  const joined = path.resolve(root, relPath);
  if (!joined.startsWith(root + path.sep) && joined !== root) {
    throw new McpError('VAULT_IO_ERROR', `[VAULT_IO_ERROR] Path traversal detected: ${relPath}`);
  }
  return joined;
}

// ── C3: Atomic file ops ──────────────────────────────────────────────────────

export interface ReadResult { content: string; mtimeMs: number; }
export interface AppendResult { bytesAppended: number; }

export async function readFileAtomic(absPath: string): Promise<ReadResult> {
  try {
    const [content, st] = await Promise.all([
      fsp.readFile(absPath, 'utf8'),
      fsp.stat(absPath),
    ]);
    return { content, mtimeMs: st.mtimeMs };
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new McpError('NOTE_NOT_FOUND', `File not found: ${absPath}`);
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, absPath);
  } catch (e: any) {
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function appendFileAtomic(absPath: string, content: string): Promise<AppendResult> {
  try {
    await fsp.appendFile(absPath, content, 'utf8');
    return { bytesAppended: Buffer.byteLength(content, 'utf8') };
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new McpError('NOTE_NOT_FOUND', `File not found: ${absPath}`);
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function deleteFile(absPath: string): Promise<void> {
  try {
    await fsp.unlink(absPath);
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new McpError('NOTE_NOT_FOUND', `File not found: ${absPath}`);
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}

export async function statFile(absPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fsp.stat(absPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw new McpError('VAULT_IO_ERROR', e.message);
  }
}
