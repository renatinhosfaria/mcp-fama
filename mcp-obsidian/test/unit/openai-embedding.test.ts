import { describe, expect, it } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/vault/semantic/openai-embedding.js';

describe('OpenAIEmbeddingProvider', () => {
  it('requests embeddings with the configured model and dimensions', async () => {
    const calls: any[] = [];
    const client = {
      embeddings: {
        create: async (input: any) => {
          calls.push(input);
          return { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] };
        },
      },
    };
    const provider = new OpenAIEmbeddingProvider(client as any, {
      model: 'text-embedding-3-large',
      dimensions: 2,
    });

    const result = await provider.embedTexts(['a', 'b']);

    expect(calls[0]).toEqual({
      model: 'text-embedding-3-large',
      input: ['a', 'b'],
      dimensions: 2,
    });
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('throws if OpenAI returns a different number of embeddings', async () => {
    const client = {
      embeddings: {
        create: async () => ({ data: [{ embedding: [0.1] }] }),
      },
    };
    const provider = new OpenAIEmbeddingProvider(client as any, {
      model: 'text-embedding-3-large',
      dimensions: 1,
    });

    await expect(provider.embedTexts(['a', 'b'])).rejects.toThrow(/embedding count/i);
  });
});
