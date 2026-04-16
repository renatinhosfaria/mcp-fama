import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync, spawn, ChildProcess } from 'node:child_process';

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

describe('e2e smoke', () => {
  let tmpVault: string; let proc: ChildProcess;
  const PORT = 3291; const KEY = 'smoketoken';

  beforeAll(async () => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));
    execSync('git init -q -b main', { cwd: tmpVault });
    execSync('git config user.email "t@t"', { cwd: tmpVault });
    execSync('git config user.name "t"', { cwd: tmpVault });
    fs.mkdirSync(path.join(tmpVault, '_shared/context'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '_shared/context/AGENTS.md'), '```\n_agents/** => alfa\nREADME.md => renato\n```');
    fs.writeFileSync(path.join(tmpVault, 'README.md'), '#');
    fs.mkdirSync(path.join(tmpVault, '_agents/alfa'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '_agents/alfa/profile.md'), `---
type: agent-profile
owner: alfa
created: 2026-04-01
updated: 2026-04-01
tags: []
---
#`);
    execSync('git add .', { cwd: tmpVault });
    execSync('git commit -q -m init', { cwd: tmpVault });

    proc = spawn('node', ['dist/index.js'], {
      env: { ...process.env, PORT: String(PORT), API_KEY: KEY, VAULT_PATH: tmpVault, GIT_LOCKFILE: path.join(tmpVault, '.lock') },
      stdio: 'inherit',
    });
    await waitHealthy(PORT);
  }, 60_000);

  afterAll(async () => {
    if (proc) proc.kill('SIGTERM');
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  async function rpc(method: string, params: any) {
    const r = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      // Parse SSE: find first data: line and parse as JSON
      const text = await r.text();
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          return JSON.parse(line.slice(6));
        }
      }
      throw new Error(`No data line in SSE response: ${text}`);
    }
    return await r.json();
  }

  it('initialize + tools/list returns 28 tools', async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    const r = await rpc('tools/list', {});
    expect(r.result.tools.length).toBe(28);
  });

  it('read_note via tools/call', async () => {
    const r = await rpc('tools/call', { name: 'read_note', arguments: { path: '_agents/alfa/profile.md' } });
    expect(r.result.structuredContent.path).toBe('_agents/alfa/profile.md');
  });

  it('create_journal_entry → file exists', async () => {
    const r = await rpc('tools/call', { name: 'create_journal_entry', arguments: { agent: 'alfa', title: 'Smoke', content: '#' } });
    const p = r.result.structuredContent.path;
    expect(p).toMatch(/^_agents\/alfa\/journal\/\d{4}-\d{2}-\d{2}-smoke\.md$/);
    expect(fs.existsSync(path.join(tmpVault, p))).toBe(true);
  });

  it('auth rejects missing bearer', async () => {
    const r = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(401);
  });
});
