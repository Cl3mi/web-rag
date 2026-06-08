/**
 * Pipeline Status Endpoint
 *
 * GET /api/pipelines/status — returns row counts per pipeline so UI can hide
 * pipelines that have no indexed data.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

export const GET: RequestHandler = async () => {
  try {
    const [chunkRows, factRows, llmRows] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM traditional_chunks`,
      sql`SELECT COUNT(*)::int AS count FROM facts_chunks`,
      sql`SELECT COUNT(*)::int AS count FROM llm_chunks`,
    ]);

    const counts = {
      chunk: Number(chunkRows[0]?.count ?? 0),
      fact: Number(factRows[0]?.count ?? 0),
      llm: Number(llmRows[0]?.count ?? 0),
    };

    return json({
      counts,
      available: {
        chunk: counts.chunk > 0,
        fact: counts.fact > 0,
        llm: counts.llm > 0,
      },
    });
  } catch (error) {
    console.error('Pipeline status error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
