import OpenAI from 'openai';
import type { EmbeddingProvider } from './types.js';

export interface OpenAIEmbeddingProviderOptions {
  model: string;
  dimensions: number;
}

interface OpenAIEmbeddingClient {
  embeddings: {
    create(input: {
      model: string;
      input: string[];
      dimensions: number;
    }): Promise<{ data: Array<{ embedding: number[] }> }>;
  };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly client: OpenAIEmbeddingClient,
    private readonly options: OpenAIEmbeddingProviderOptions,
  ) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.client.embeddings.create({
      model: this.options.model,
      input: texts,
      dimensions: this.options.dimensions,
    });

    if (response.data.length !== texts.length) {
      throw new Error(
        `OpenAI embedding count mismatch: expected ${texts.length}, received ${response.data.length}`,
      );
    }

    return response.data.map((item) => item.embedding);
  }
}

export function createOpenAIEmbeddingProvider(
  apiKey: string,
  options: OpenAIEmbeddingProviderOptions,
): OpenAIEmbeddingProvider {
  return new OpenAIEmbeddingProvider(new OpenAI({ apiKey }), options);
}
