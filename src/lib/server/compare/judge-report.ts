import { judgeAnswer, classifyFailureType } from '$lib/server/evaluation/judge';
import type { EvalReport, JudgedRow } from './types';

/** Judge every row of a report. Returns judged rows aligned to report.rows. */
export async function judgeReport(report: EvalReport): Promise<JudgedRow[]> {
  const out: JudgedRow[] = [];
  for (const row of report.rows) {
    const scores = await judgeAnswer({
      question: row.query,
      context: row.context,
      answer: row.answer,
      runs: 3,
    });

    if (!scores) {
      out.push({
        queryId: row.queryId, query: row.query,
        groundedness: 0, completeness: 0, correctness: 0,
        hallucination: false, answerableFromContext: false,
        judgeMean: 0, failureType: null,
        recallAt10: row.retrieval.recallAt10, totalMs: row.latency.totalMs,
      });
      continue;
    }

    const answerable = scores.answerableFromContext ?? true;
    // Zero out unanswerable rows to match internal quality methodology.
    const groundedness = answerable ? scores.groundedness : 0;
    const completeness = answerable ? scores.completeness : 0;
    const correctness = answerable ? scores.answerQuality : 0;
    const judgeMean = answerable
      ? (scores.groundedness + scores.completeness + scores.answerQuality) / 3
      : 0;
    const failureType = classifyFailureType(
      row.retrieval.recallAt10,
      (scores.groundedness + scores.completeness + scores.answerQuality) / 3,
      scores.hallucination,
      scores.answerableFromContext,
    );

    out.push({
      queryId: row.queryId, query: row.query,
      groundedness, completeness, correctness,
      hallucination: scores.hallucination,
      answerableFromContext: answerable,
      judgeMean, failureType,
      recallAt10: row.retrieval.recallAt10, totalMs: row.latency.totalMs,
    });
  }
  return out;
}
