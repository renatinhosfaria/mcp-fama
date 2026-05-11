import { describe, expect, it } from 'vitest';
import { normalizeDateInput, buildV1Frontmatter, validateV1Frontmatter } from '../../src/vault/schema-v1.js';

describe('schema v1 dates', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(normalizeDateInput('2026-05-11')).toEqual({ date: '2026-05-11' });
  });

  it('accepts ISO-8601 with timezone and derives date', () => {
    expect(normalizeDateInput('2026-05-11T14:30:00-03:00')).toEqual({
      date: '2026-05-11',
      timestamp: '2026-05-11T14:30:00-03:00',
    });
  });
});

describe('schema v1 frontmatter', () => {
  it('builds required common fields and preserves extras', () => {
    const fm = buildV1Frontmatter({
      type: 'journal',
      status: 'active',
      source: 'agent-generated',
      tags: ['reno'],
      author_agent: 'reno',
      extra: 'ok',
    }, '2026-05-11');
    expect(fm.schema_version).toBe(1);
    expect(fm.created).toBe('2026-05-11');
    expect(fm.updated).toBe('2026-05-11');
    expect(fm.extra).toBe('ok');
  });

  it('rejects v1 missing required fields', () => {
    expect(() => validateV1Frontmatter({ schema_version: 1, type: 'journal' })).toThrow(/INVALID_SCHEMA_V1/);
  });
});
