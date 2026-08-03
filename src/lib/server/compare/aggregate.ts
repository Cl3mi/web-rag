import type { JudgedRow, SystemAggregate } from './types';

function meanExcludingUnanswerable(rows: JudgedRow[], pick: (r: JudgedRow) => number): number | null {
  const vals = rows.filter((r) => r.answerableFromContext).map(pick);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function aggregateJudged(systemLabel: string, rows: JudgedRow[]): SystemAggregate {
  const failureTypeCounts: Record<string, number> = {};
  for (const r of rows) {
    const key = r.failureType ?? 'unclassified';
    failureTypeCounts[key] = (failureTypeCounts[key] ?? 0) + 1;
  }
  const hallucinationCount = rows.filter((r) => r.hallucination).length;
  const answerableCount = rows.filter((r) => r.answerableFromContext).length;

  return {
    systemLabel,
    total: rows.length,
    judge: {
      groundedness: meanExcludingUnanswerable(rows, (r) => r.groundedness),
      completeness: meanExcludingUnanswerable(rows, (r) => r.completeness),
      correctness: meanExcludingUnanswerable(rows, (r) => r.correctness),
      judgeMean: meanExcludingUnanswerable(rows, (r) => r.judgeMean),
    },
    hallucinationRate: rows.length ? hallucinationCount / rows.length : 0,
    failureTypeCounts,
    answerableRate: rows.length ? answerableCount / rows.length : 0,
  };
}
