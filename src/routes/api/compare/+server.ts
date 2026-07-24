import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { EvalReport } from '$lib/server/compare/types';
import { judgeReport } from '$lib/server/compare/judge-report';
import { aggregateJudged } from '$lib/server/compare/aggregate';
import { saveComparison } from '$lib/server/compare/store';
import type { ComparisonPayload } from '$lib/server/compare/types';

function isReport(x: unknown): x is EvalReport {
  const r = x as EvalReport;
  return !!r && typeof r.systemLabel === 'string' && Array.isArray(r.rows) &&
    typeof r.questionSetVersion === 'string';
}

function meanLatency(report: EvalReport, key: 'retrievalMs' | 'generationMs' | 'totalMs'): number {
  const rows = report.rows;
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + r.latency[key], 0) / rows.length;
}

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { reportA?: unknown; reportB?: unknown } | null;
  if (!body || !isReport(body.reportA) || !isReport(body.reportB)) {
    return json({ error: 'Required: { reportA, reportB } — two eval reports' }, { status: 400 });
  }
  const reportA = body.reportA;
  const reportB = body.reportB;

  const [judgedA, judgedB] = await Promise.all([judgeReport(reportA), judgeReport(reportB)]);

  const payload: ComparisonPayload = {
    reportA: { systemLabel: reportA.systemLabel, questionSetVersion: reportA.questionSetVersion, sessionId: reportA.sessionId },
    reportB: { systemLabel: reportB.systemLabel, questionSetVersion: reportB.questionSetVersion, sessionId: reportB.sessionId },
    versionMismatch: reportA.questionSetVersion !== reportB.questionSetVersion,
    aggregates: {
      a: aggregateJudged(reportA.systemLabel, judgedA),
      b: aggregateJudged(reportB.systemLabel, judgedB),
    },
    judgedRows: { a: judgedA, b: judgedB },
    latency: {
      a: { retrievalMs: meanLatency(reportA, 'retrievalMs'), generationMs: meanLatency(reportA, 'generationMs'), totalMs: meanLatency(reportA, 'totalMs') },
      b: { retrievalMs: meanLatency(reportB, 'retrievalMs'), generationMs: meanLatency(reportB, 'generationMs'), totalMs: meanLatency(reportB, 'totalMs') },
    },
  };

  const id = await saveComparison(payload);
  return json({ id, ...payload });
};
