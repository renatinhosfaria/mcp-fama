// test/integration/training-target-delta.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VaultIndex } from '../../src/vault/index.js';
import { getTrainingTargetDelta } from '../../src/tools/workflows.js';

describe('get_training_target_delta', () => {
  let tmp: string;
  let ctx: any;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ttd-'));
    fs.mkdirSync(path.join(tmp, '_shared/context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '_shared/context/AGENTS.md'),
      [
        '```',
        '_agents/reno/**                       => reno',
        '_agents/sparring/**                   => sparring',
        '_agents/follow-up/**                  => follow-up',
        '_shared/context/*/reno/**             => reno',
        '_shared/context/*/sparring/**         => sparring',
        '_shared/context/*/follow-up/**        => follow-up',
        '```',
      ].join('\n'),
    );

    const mkNote = (rel: string, fm: Record<string, any>, body: string, mtime: Date) => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const fmYaml = Object.entries(fm)
        .map(([k, v]) => {
          if (Array.isArray(v)) return `${k}: [${v.map(x => `"${x}"`).join(', ')}]`;
          return `${k}: ${v}`;
        })
        .join('\n');
      fs.writeFileSync(abs, `---\n${fmYaml}\n---\n${body}`);
      fs.utimesSync(abs, mtime, mtime);
    };

    // reno writes own journal (recent)
    fs.mkdirSync(path.join(tmp, '_agents/reno/journal'), { recursive: true });
    mkNote(
      '_agents/reno/journal/2026-04-14-reflection.md',
      { type: 'journal', owner: 'reno', created: '2026-04-14', updated: '2026-04-14', tags: [] },
      'Reno self-reflection.',
      new Date('2026-04-14T00:00:00Z'),
    );

    // sparring writes a regression about reno (recent, regressoes/ topic, with body + tag)
    mkNote(
      '_shared/context/regressoes/sparring/reno-tom-frio.md',
      {
        type: 'shared-context',
        owner: 'sparring',
        created: '2026-04-12',
        updated: '2026-04-12',
        tags: ['#alvo-reno', '#regressao-aberta', '#severidade-alta', '#categoria-tom'],
        topic: 'regressoes',
        title: 'Reno tom frio em objeção',
      },
      [
        '## Agente alvo',
        'reno',
        '',
        '## Cenário',
        'Lead objetou entrada alta.',
        '',
        '## Severidade',
        'alta',
        '',
        '## Status',
        'aberta',
        '',
        '## Categoria',
        'tom',
        '',
      ].join('\n'),
      new Date('2026-04-12T00:00:00Z'),
    );

    // follow-up writes a shared-context in aprendizados/ mentioning reno via tag (recent)
    mkNote(
      '_shared/context/aprendizados/follow-up/reno-melhorou.md',
      {
        type: 'shared-context',
        owner: 'follow-up',
        created: '2026-04-13',
        updated: '2026-04-13',
        tags: ['#alvo-reno'],
        topic: 'aprendizados',
        title: 'Reno melhorou em objeções',
      },
      'Observação: reno está respondendo melhor.',
      new Date('2026-04-13T00:00:00Z'),
    );

    // follow-up writes a shared-context NOT mentioning reno (should be excluded)
    mkNote(
      '_shared/context/abordagens/follow-up/abertura-curta.md',
      {
        type: 'shared-context',
        owner: 'follow-up',
        created: '2026-04-13',
        updated: '2026-04-13',
        tags: ['#canal-whatsapp'],
        topic: 'abordagens',
        title: 'Abertura curta funciona',
      },
      'Abertura curta aumenta resposta.',
      new Date('2026-04-13T00:00:00Z'),
    );

    // reno writes own shared-context in regressoes/ (SELF — must be excluded from shared_about_target per spec "de outros owners")
    mkNote(
      '_shared/context/regressoes/reno/self-reflection.md',
      {
        type: 'shared-context',
        owner: 'reno',
        created: '2026-04-14',
        updated: '2026-04-14',
        tags: ['#alvo-reno'],
        topic: 'regressoes',
        title: 'Auto-reflexão',
      },
      '## Agente alvo\nreno\n',
      new Date('2026-04-14T00:00:00Z'),
    );

    // old regression (pre-since) should be excluded
    mkNote(
      '_shared/context/regressoes/sparring/old-issue.md',
      {
        type: 'shared-context',
        owner: 'sparring',
        created: '2026-01-01',
        updated: '2026-01-01',
        tags: ['#alvo-reno'],
        topic: 'regressoes',
        title: 'Old issue',
      },
      '## Agente alvo\nreno\n',
      new Date('2026-01-01T00:00:00Z'),
    );

    const index = new VaultIndex(tmp);
    await index.build();
    ctx = { index, vaultRoot: tmp };
  });

  it('returns target_agent_delta + shared_about_target + regressions, dedupe and self-exclusion correct', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;

    // target_agent_delta: reno's own journal
    expect(sc.target_agent_delta.journals).toHaveLength(1);
    expect(sc.target_agent_delta.journals[0].path).toBe('_agents/reno/journal/2026-04-14-reflection.md');

    // shared_about_target: sparring's regression + follow-up's aprendizado (NOT reno's self + NOT the old one + NOT abordagens without tag)
    expect(sc.shared_about_target).toHaveLength(2);
    const pathsAbout = sc.shared_about_target.map((e: any) => e.path).sort();
    expect(pathsAbout).toEqual([
      '_shared/context/aprendizados/follow-up/reno-melhorou.md',
      '_shared/context/regressoes/sparring/reno-tom-frio.md',
    ]);
    // Each has topic field populated from path
    expect(sc.shared_about_target.find((e: any) => e.topic === 'regressoes')).toBeDefined();
    expect(sc.shared_about_target.find((e: any) => e.topic === 'aprendizados')).toBeDefined();

    // regressions: just the sparring one, with projected fields
    expect(sc.regressions).toHaveLength(1);
    expect(sc.regressions[0].path).toBe('_shared/context/regressoes/sparring/reno-tom-frio.md');
    expect(sc.regressions[0].status).toBe('aberta');
    expect(sc.regressions[0].severidade).toBe('alta');
    expect(sc.regressions[0].categoria).toBe('tom');

    // total = target_agent_delta_total (1 journal + 1 reno-owned shared_context) + 2 (shared_about) + 1 (regressions) = 5
    // regressions is intentionally double-counted as a projection, not an exclusion, per spec.
    expect(sc.total).toBe(5);
  });

  it('body-only mention (no #alvo-reno tag) still matches for regressoes topic', async () => {
    // Write a regression from sparring that mentions reno ONLY in body, not tag
    const rel = '_shared/context/regressoes/sparring/body-only.md';
    const abs = path.join(tmp, rel);
    fs.writeFileSync(abs, `---
type: shared-context
owner: sparring
created: 2026-04-15
updated: 2026-04-15
tags: []
topic: regressoes
title: Body-only mention
---
## Agente alvo
reno

## Status
aberta
`);
    const mtime = new Date('2026-04-15T00:00:00Z');
    fs.utimesSync(abs, mtime, mtime);
    await ctx.index.updateAfterWrite(rel);

    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    const pathsAbout = sc.shared_about_target.map((e: any) => e.path);
    expect(pathsAbout).toContain(rel);
    const reg = sc.regressions.find((e: any) => e.path === rel);
    expect(reg).toBeDefined();
    expect(reg.status).toBe('aberta');
  });

  it('topics[] filter scopes shared_about_target and regressions but not target_agent_delta', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z', topics: ['regressoes'] },
      ctx,
    );
    const sc = (r as any).structuredContent;
    // target_agent_delta is unfiltered by topics — journal still present
    expect(sc.target_agent_delta.journals).toHaveLength(1);
    // shared_about_target should only have regressoes entries
    expect(sc.shared_about_target.every((e: any) => e.topic === 'regressoes')).toBe(true);
    // follow-up aprendizado excluded
    const hasAprendizado = sc.shared_about_target.some((e: any) => e.topic === 'aprendizados');
    expect(hasAprendizado).toBe(false);
  });

  it('include_content=true returns full body on target + shared', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2026-04-10T00:00:00Z', include_content: true },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.target_agent_delta.journals[0].content).toBeDefined();
    expect(sc.shared_about_target[0].content).toBeDefined();
  });

  it('INVALID_TIME_RANGE for malformed since', async () => {
    const r = await getTrainingTargetDelta({ target_agent: 'reno', since: 'garbage' }, ctx);
    expect((r as any).structuredContent.error.code).toBe('INVALID_TIME_RANGE');
  });

  it('empty result when since is in the future', async () => {
    const r = await getTrainingTargetDelta(
      { target_agent: 'reno', since: '2099-01-01T00:00:00Z' },
      ctx,
    );
    const sc = (r as any).structuredContent;
    expect(sc.target_agent_delta.journals).toHaveLength(0);
    expect(sc.shared_about_target).toHaveLength(0);
    expect(sc.regressions).toHaveLength(0);
    expect(sc.total).toBe(0);
  });
});
