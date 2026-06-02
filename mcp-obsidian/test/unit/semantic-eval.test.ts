import { describe, expect, it } from 'vitest';
import { evaluateSemanticResults } from '../../src/vault/semantic/eval.js';

describe('evaluateSemanticResults', () => {
  it('computes hit rate and mean reciprocal rank', () => {
    const result = evaluateSemanticResults([
      {
        query: 'cliente pediu valores',
        expectedPaths: ['_journal/alfa/a.md'],
        actualPaths: ['_journal/alfa/a.md', '_journal/alfa/b.md'],
      },
      {
        query: 'runbook de repasse',
        expectedPaths: ['_runbooks/alfa-repasse.md'],
        actualPaths: ['_journal/alfa/a.md', '_runbooks/alfa-repasse.md'],
      },
      {
        query: 'nao encontrado',
        expectedPaths: ['missing.md'],
        actualPaths: [],
      },
    ]);

    expect(result.hitRateAt5).toBeCloseTo(2 / 3);
    expect(result.meanReciprocalRank).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(result.cases).toBe(3);
  });

  it('returns zero metrics for an empty evaluation set', () => {
    expect(evaluateSemanticResults([])).toEqual({
      cases: 0,
      hitRateAt5: 0,
      meanReciprocalRank: 0,
    });
  });
});
