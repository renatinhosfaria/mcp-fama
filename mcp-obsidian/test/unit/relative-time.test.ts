// test/unit/relative-time.test.ts
import { describe, it, expect } from 'vitest';
import { parseRelativeOrIsoSince } from '../../src/tools/_shared.js';

describe('parseRelativeOrIsoSince', () => {
  const now = Date.parse('2026-04-16T12:00:00Z');

  it('parses 7d → 7 days before now', () => {
    const ms = parseRelativeOrIsoSince('7d', now);
    const diff = now - ms;
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses 30d, 1w, 2m, 1y correctly', () => {
    expect(now - parseRelativeOrIsoSince('30d', now)).toBe(30 * 86400_000);
    expect(now - parseRelativeOrIsoSince('1w',  now)).toBe(7 * 86400_000);
    expect(now - parseRelativeOrIsoSince('2m',  now)).toBe(60 * 86400_000);
    expect(now - parseRelativeOrIsoSince('1y',  now)).toBe(365 * 86400_000);
  });

  it('parses ISO-8601 datetime passthrough', () => {
    const ms = parseRelativeOrIsoSince('2026-04-09T00:00:00Z', now);
    expect(ms).toBe(Date.parse('2026-04-09T00:00:00Z'));
  });

  it('throws INVALID_RELATIVE_TIME for garbage', () => {
    expect(() => parseRelativeOrIsoSince('garbage', now)).toThrow(/INVALID_RELATIVE_TIME/);
  });

  it('throws INVALID_RELATIVE_TIME for empty string', () => {
    expect(() => parseRelativeOrIsoSince('', now)).toThrow(/INVALID_RELATIVE_TIME/);
  });

  it('throws INVALID_RELATIVE_TIME for partial match (7days)', () => {
    expect(() => parseRelativeOrIsoSince('7days', now)).toThrow(/INVALID_RELATIVE_TIME/);
  });
});
