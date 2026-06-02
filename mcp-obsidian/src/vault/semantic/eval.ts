export interface SemanticEvalCase {
  query: string;
  expectedPaths: string[];
  actualPaths: string[];
}

export interface SemanticEvalResult {
  cases: SemanticEvalCase[];
  hitRateAt5: number;
  meanReciprocalRank: number;
}

export function evaluateSemanticResults(cases: SemanticEvalCase[]): SemanticEvalResult {
  if (cases.length === 0) {
    return { cases, hitRateAt5: 0, meanReciprocalRank: 0 };
  }

  let hits = 0;
  let reciprocalRankTotal = 0;

  for (const evalCase of cases) {
    const expected = new Set(evalCase.expectedPaths);
    const topFive = evalCase.actualPaths.slice(0, 5);
    const firstMatchIndex = topFive.findIndex((path) => expected.has(path));

    if (firstMatchIndex >= 0) {
      hits += 1;
      reciprocalRankTotal += 1 / (firstMatchIndex + 1);
    }
  }

  return {
    cases,
    hitRateAt5: hits / cases.length,
    meanReciprocalRank: reciprocalRankTotal / cases.length,
  };
}
