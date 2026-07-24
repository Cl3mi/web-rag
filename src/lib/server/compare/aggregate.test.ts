import { describe, it, expect } from 'vitest';
import { aggregateJudged } from './aggregate';
import type { JudgedRow } from './types';

const jr = (over: Partial<JudgedRow>): JudgedRow => ({
  queryId: 'q', query: 'x', groundedness: 4, completeness: 4, correctness: 4,
  hallucination: false, answerableFromContext: true, judgeMean: 4,
  failureType: 'normal', recallAt10: 1, totalMs: 100, ...over,
});

describe('aggregateJudged', () => {
  it('excludes unanswerable rows (scores 0) from judge averages', () => {
    const rows = [
      jr({ groundedness: 4, completeness: 4, correctness: 4, judgeMean: 4 }),
      jr({ answerableFromContext: false, groundedness: 0, completeness: 0, correctness: 0,
           judgeMean: 0, failureType: 'retrieval_failure' }),
    ];
    const agg = aggregateJudged('sys', rows);
    // Only the answerable row counts toward the judge means.
    expect(agg.judge.groundedness).toBe(4);
    expect(agg.judge.judgeMean).toBe(4);
    expect(agg.answerableRate).toBe(0.5);
  });

  it('counts failure types and hallucination rate', () => {
    const rows = [
      jr({ failureType: 'normal' }),
      jr({ failureType: 'normal' }),
      jr({ failureType: 'hallucination_failure', hallucination: true }),
    ];
    const agg = aggregateJudged('sys', rows);
    expect(agg.failureTypeCounts).toEqual({ normal: 2, hallucination_failure: 1 });
    expect(agg.hallucinationRate).toBeCloseTo(1 / 3);
    expect(agg.total).toBe(3);
  });

  it('returns null judge means when every row is unanswerable', () => {
    const rows = [jr({ answerableFromContext: false, groundedness: 0, completeness: 0, correctness: 0, judgeMean: 0 })];
    const agg = aggregateJudged('sys', rows);
    expect(agg.judge.groundedness).toBeNull();
  });
});
