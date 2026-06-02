import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { SemanticChunk } from './types.js';

interface ChunkMarkdownSectionsInput {
  path: string;
  content: string;
  previewChars: number;
  maxChunkChars?: number;
}

interface MarkdownSection {
  heading: string;
  heading_path: string[];
  lines: string[];
}

interface FenceMarker {
  char: '`' | '~';
  length: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 4000;

export function chunkMarkdownSections(input: ChunkMarkdownSectionsInput): SemanticChunk[] {
  const content = normalizeText(matter(input.content).content);
  const maxChunkChars = input.maxChunkChars !== undefined && input.maxChunkChars > 0
    ? input.maxChunkChars
    : DEFAULT_MAX_CHUNK_CHARS;

  if (content.length === 0) {
    return [];
  }

  const sections = collectSections(content);
  const chunks: SemanticChunk[] = [];

  for (const section of sections) {
    const sectionText = normalizeText(section.lines.join('\n'));
    if (sectionText.length === 0) {
      continue;
    }

    for (const text of splitSectionText(sectionText, maxChunkChars)) {
      chunks.push(toSemanticChunk(input, chunks.length, section, text));
    }
  }

  return chunks;
}

function collectSections(content: string): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  const headingStack: string[] = [];
  let current: MarkdownSection | undefined;
  let fenceMarker: FenceMarker | undefined;

  for (const line of lines) {
    if (fenceMarker !== undefined) {
      current = appendLine(sections, current, line);
      if (isFenceClose(line, fenceMarker)) {
        fenceMarker = undefined;
      }
      continue;
    }

    const heading = parseHeading(line);

    if (heading === undefined) {
      current = appendLine(sections, current, line);
      const openingFence = parseFenceOpening(line);
      if (openingFence !== undefined) {
        fenceMarker = openingFence;
      }
      continue;
    }

    headingStack.length = heading.level - 1;
    headingStack[heading.level - 1] = heading.text;

    current = {
      heading: heading.text,
      heading_path: headingStack.filter((value): value is string => value !== undefined),
      lines: [line],
    };
    sections.push(current);
  }

  return sections;
}

function appendLine(
  sections: MarkdownSection[],
  current: MarkdownSection | undefined,
  line: string,
): MarkdownSection {
  if (current === undefined) {
    current = {
      heading: 'Document',
      heading_path: ['Document'],
      lines: [],
    };
    sections.push(current);
  }

  current.lines.push(line);
  return current;
}

function parseHeading(line: string): { level: number; text: string } | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (match === null) {
    return undefined;
  }

  return {
    level: match[1].length,
    text: match[2].trim(),
  };
}

function parseFenceOpening(line: string): FenceMarker | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (match === null) {
    return undefined;
  }

  return {
    char: match[1][0] as '`' | '~',
    length: match[1].length,
  };
}

function isFenceClose(line: string, fenceMarker: FenceMarker): boolean {
  const escapedChar = fenceMarker.char === '`' ? '`' : '~';
  const closePattern = new RegExp(`^ {0,3}${escapedChar}{${fenceMarker.length},} *$`);
  return closePattern.test(line);
}

function splitSectionText(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';

  for (const paragraph of paragraphs) {
    const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;

    if (next.length <= maxChunkChars) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }

    if (paragraph.length <= maxChunkChars) {
      current = paragraph;
      continue;
    }

    chunks.push(...splitLongParagraph(paragraph, maxChunkChars));
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongParagraph(paragraph: string, maxChunkChars: number): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < paragraph.length; index += maxChunkChars) {
    chunks.push(paragraph.slice(index, index + maxChunkChars));
  }

  return chunks;
}

function toSemanticChunk(
  input: ChunkMarkdownSectionsInput,
  chunkIndex: number,
  section: MarkdownSection,
  text: string,
): SemanticChunk {
  const normalizedText = normalizeText(text);

  return {
    path: input.path,
    chunk_index: chunkIndex,
    heading: section.heading,
    heading_path: section.heading_path,
    text: normalizedText,
    preview: normalizedText.slice(0, input.previewChars),
    content_hash: createHash('sha256').update(normalizedText).digest('hex'),
  };
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}
