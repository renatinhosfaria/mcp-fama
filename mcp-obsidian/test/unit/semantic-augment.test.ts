import { describe, expect, it } from 'vitest';
import { ok } from '../../src/tools/_shared.js';
import { augmentSemanticResponse } from '../../src/tools/semantic-augment.js';

const memoryHit = {
  path: '_journal/alfa/2026-05-11-lead.md',
  chunk_id: 'hit-1',
  chunk_index: 0,
  heading: 'Atendimento',
  heading_path: ['Atendimento'],
  preview: 'Cliente pediu valores.',
  owner: 'alfa',
  type: 'journal',
  tags: ['lead'],
  score: 0.91,
  source: 'hybrid' as const,
};

describe('augmentSemanticResponse', () => {
  it('adds semantic_memory to successful read responses', async () => {
    const ctx: any = {
      semantic: {
        search: async (input: any) => {
          expect(input.query).toContain('Cliente atual');
          expect(input.filter.excludePath).toBe('_journal/alfa/current.md');
          return [memoryHit];
        },
      },
    };
    const response = ok({
      path: '_journal/alfa/current.md',
      content: '# Cliente atual\nPrecisa de financiamento.',
    }, 'Read current');

    const augmented = await augmentSemanticResponse('read_note', { path: '_journal/alfa/current.md' }, response, ctx, { readOnlyHint: true });

    expect((augmented.structuredContent as any).semantic_memory).toEqual([memoryHit]);
  });

  it('adds semantic_warnings to successful write responses', async () => {
    const ctx: any = {
      semantic: {
        search: async () => [memoryHit],
      },
    };
    const response = ok({ path: '_journal/alfa/new.md', created: true }, 'Created');

    const augmented = await augmentSemanticResponse('create_journal_event', {
      title: 'Atendimento',
      content: 'Cliente pediu valores.',
    }, response, ctx, { openWorldHint: false });

    expect((augmented.structuredContent as any).semantic_warnings).toEqual([memoryHit]);
  });

  it('does not fail the original tool when semantic search fails', async () => {
    const ctx: any = {
      semantic: {
        search: async () => { throw new Error('postgres down'); },
      },
    };
    const response = ok({ path: 'x.md' }, 'ok');

    const augmented = await augmentSemanticResponse('search_content', { query: 'x' }, response, ctx, { readOnlyHint: true });

    expect(augmented).toBe(response);
  });

  it('returns the original response when semantic memory is not configured', async () => {
    const response = ok({ path: 'x.md', content: 'Cliente atual' }, 'ok');

    const augmented = await augmentSemanticResponse('read_note', { path: 'x.md' }, response, {}, { readOnlyHint: true });

    expect(augmented).toBe(response);
  });

  it('returns the original response when the original tool failed', async () => {
    const ctx: any = {
      semantic: {
        search: async () => {
          throw new Error('semantic search should not run');
        },
      },
    };
    const response = { ...ok({ path: 'x.md' }, 'error'), isError: true };

    const augmented = await augmentSemanticResponse('read_note', { path: 'x.md' }, response, ctx, { readOnlyHint: true });

    expect(augmented).toBe(response);
  });

  it('limits automatic semantic search to five matches', async () => {
    const ctx: any = {
      semantic: {
        search: async (input: any) => {
          expect(input.limit).toBe(5);
          return [memoryHit];
        },
      },
    };
    const response = ok({ path: 'x.md', content: 'Cliente atual' }, 'ok');

    await augmentSemanticResponse('read_note', { path: 'x.md' }, response, ctx, { readOnlyHint: true });
  });

  it('extracts semantic filters from arguments and structured content', async () => {
    const ctx: any = {
      semantic: {
        search: async (input: any) => {
          expect(input.filter).toEqual({
            path: '_journal/alfa',
            owner: 'alfa',
            type: 'journal',
            tag: 'lead',
            excludePath: '_journal/alfa/current.md',
          });
          return [memoryHit];
        },
      },
    };
    const response = ok({
      path: '_journal/alfa/current.md',
      content: '# Cliente atual',
      owner: 'alfa',
      type: 'journal',
      tags: ['lead'],
    }, 'ok');

    await augmentSemanticResponse('read_note', {
      path: '_journal/alfa',
      owner: 'alfa',
      type: 'journal',
      tag: 'lead',
    }, response, ctx, { readOnlyHint: true });
  });
});
