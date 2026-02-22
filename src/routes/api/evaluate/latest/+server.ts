/**
 * Latest Evaluation API Endpoint
 *
 * GET /api/evaluate/latest
 * Returns the most recent evaluation results for comparison.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

export const GET: RequestHandler = async () => {
  try {
    // Get the most recent completed evaluation run
    const runs = await sql`
      SELECT id, name, pipeline, config, metrics, status, started_at, completed_at
      FROM evaluation_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `;

    if (runs.length === 0) {
      return json({ run: null, results: [] });
    }

    const run = runs[0];
    const runId = run.id as string;

    // Get per-query results for this run
    const results = await sql`
      SELECT
        er.id,
        er.pipeline,
        er.retrieved_ids,
        er.scores,
        er.metrics,
        er.latency_ms,
        tq.query,
        tq.category,
        tq.difficulty,
        tq.expected_document_ids
      FROM evaluation_results er
      JOIN test_queries tq ON er.query_id = tq.id
      WHERE er.run_id = ${runId}
      ORDER BY er.pipeline, tq.query
    `;

    // Group results by pipeline (support both old and new naming)
    const groupedResults = {
      chunk: results.filter((r) => r.pipeline === 'chunk' || r.pipeline === 'traditional'),
      fact: results.filter((r) => r.pipeline === 'fact' || r.pipeline === 'facts'),
      llm: results.filter((r) => r.pipeline === 'llm'),
    };

    return json({
      run: {
        id: run.id,
        name: run.name,
        pipeline: run.pipeline,
        config: run.config,
        metrics: run.metrics,
        status: run.status,
        startedAt: run.started_at,
        completedAt: run.completed_at,
      },
      results: groupedResults,
    });
  } catch (error) {
    console.error('Get latest evaluation error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
