/**
 * Judge API Endpoint
 *
 * POST /api/judge - Run LLM-as-judge on unjudged evaluation rows
 * GET /api/judge - Get quality metrics per pipeline
 * GET /api/judge?runId=xxx - Get judge results for a specific run
 * GET /api/judge?details=1&failureType=xxx&pipeline=xxx - Get detailed judge rows
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runJudge, getQualityMetrics, getQualityComparison, getJudgeResultsForRun, getJudgeDetails, repairFailureTypes } from '$lib/server/evaluation/judge';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      batchSize = 20,
      judgeModel,
      maxRows = 200,
      judgeRuns = 3,
    } = body;

    const result = await runJudge({ batchSize, judgeModel, maxRows, judgeRuns });

    // Repair any NULL failure_types (from rows missing recall_at_k)
    const repair = await repairFailureTypes();

    return json({
      status: 'completed',
      ...result,
      repaired: repair.repaired,
    });
  } catch (error) {
    console.error('Judge error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Judge process failed' },
      { status: 500 }
    );
  }
};

export const GET: RequestHandler = async ({ url }) => {
  try {
    // Check `details` first — the drill-down URL includes both details=1 AND runId,
    // so this must be matched before the bare runId branch below.
    const details = url.searchParams.get('details');
    if (details) {
      const failureType = url.searchParams.get('failureType') || undefined;
      const pipeline = url.searchParams.get('pipeline') || undefined;
      const runId = url.searchParams.get('runId') || undefined;
      const rows = await getJudgeDetails({ failureType, pipeline, runId });
      return json({ details: rows });
    }

    const runId = url.searchParams.get('runId');
    if (runId) {
      const results = await getJudgeResultsForRun(runId);
      return json({ results });
    }

    // Auto-repair NULL failure_types before returning metrics
    await repairFailureTypes();
    const [metrics, comparison] = await Promise.all([
      getQualityMetrics(),
      getQualityComparison(),
    ]);
    return json({ metrics, comparison });
  } catch (error) {
    console.error('Get judge results error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to get judge results' },
      { status: 500 }
    );
  }
};
