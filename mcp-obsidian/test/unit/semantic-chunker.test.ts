import { describe, expect, it } from 'vitest';
import { chunkMarkdownSections } from '../../src/vault/semantic/chunker.js';

describe('chunkMarkdownSections', () => {
  it('chunks Markdown by heading sections and strips frontmatter', () => {
    const chunks = chunkMarkdownSections({
      path: '_journal/alfa/2026-05-11-atendimento.md',
      content: `---
type: journal
owner: alfa
---
# Atendimento
Cliente pediu tabela.

## Proximo passo
Enviar valores.`,
      previewChars: 600,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      path: '_journal/alfa/2026-05-11-atendimento.md',
      chunk_index: 0,
      heading: 'Atendimento',
      heading_path: ['Atendimento'],
      text: '# Atendimento\nCliente pediu tabela.',
      preview: '# Atendimento\nCliente pediu tabela.',
    });
    expect(chunks[1].heading_path).toEqual(['Atendimento', 'Proximo passo']);
    expect(chunks[1].content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps intro text before the first heading as a document section', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/alfa-operacao.md',
      content: 'Resumo inicial.\n\n# Operacao\nPasso 1.',
      previewChars: 600,
    });

    expect(chunks.map((c) => c.heading)).toEqual(['Document', 'Operacao']);
    expect(chunks[0].text).toBe('Resumo inicial.');
  });

  it('limits previews without truncating stored text', () => {
    const chunks = chunkMarkdownSections({
      path: '_entities/cliente.md',
      content: '# Cliente\n' + 'x'.repeat(1000),
      previewChars: 20,
    });

    expect(chunks[0].text.length).toBeGreaterThan(900);
    expect(chunks[0].preview.length).toBe(20);
  });

  it('splits very large sections on paragraph boundaries', () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) => `Paragrafo ${i} inicio ${'x'.repeat(180)} fim ${i}`,
    );
    const chunks = chunkMarkdownSections({
      path: '_runbooks/big.md',
      content: '# Big\n' + paragraphs.join('\n\n'),
      previewChars: 600,
      maxChunkChars: 500,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 500)).toBe(true);
    for (const paragraph of paragraphs) {
      expect(chunks.filter((chunk) => chunk.text.includes(paragraph))).toHaveLength(1);
    }
  });

  it('does not treat headings inside fenced code blocks as sections', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/code.md',
      content: '# Runbook\n\n```bash\n# not a markdown heading\n```\n\n## Depois\nContinuar.',
      previewChars: 600,
    });

    expect(chunks.map((chunk) => chunk.heading)).toEqual(['Runbook', 'Depois']);
    expect(chunks[0].text).toContain('# not a markdown heading');
    expect(chunks[0].heading).not.toBe('not a markdown heading');
  });

  it('recognizes fenced code blocks indented up to three spaces', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/indented-code.md',
      content: '# Runbook\n\n   ```bash\n# not a markdown heading\n   ```\n\n## Depois\nContinuar.',
      previewChars: 600,
    });

    expect(chunks.map((chunk) => chunk.heading)).toEqual(['Runbook', 'Depois']);
    expect(chunks[0].text).toContain('# not a markdown heading');
  });

  it('does not close fenced code blocks on marker text with trailing content', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/invalid-close.md',
      content: '# Runbook\n\n```bash\n```not a closing fence\n# still code\n```\n\n## Depois\nContinuar.',
      previewChars: 600,
    });

    expect(chunks.map((chunk) => chunk.heading)).toEqual(['Runbook', 'Depois']);
    expect(chunks[0].text).toContain('# still code');
  });

  it('uses the default chunk size when maxChunkChars is not positive', () => {
    const chunks = chunkMarkdownSections({
      path: '_runbooks/non-positive-limit.md',
      content: '# Runbook\n' + 'x'.repeat(1000),
      previewChars: 600,
      maxChunkChars: 0,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.length).toBeGreaterThan(1000);
  });
});
