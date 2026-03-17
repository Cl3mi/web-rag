/**
 * Nuke API Endpoint
 *
 * POST /api/nuke
 * Deletes ALL data: documents, chunks, facts, LLM summaries,
 * evaluation runs, judge results, preferences, test queries, models.
 * Irreversible — intended for a full lab reset.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

export const POST: RequestHandler = async () => {
  try {
    // Delete in FK-safe order (children before parents)
    await sql`DELETE FROM rag_judge_results`;
    await sql`DELETE FROM rag_preferences`;
    await sql`DELETE FROM evaluation_results`;
    await sql`DELETE FROM rag_runs_evaluation`;
    await sql`DELETE FROM evaluation_runs`;
    await sql`DELETE FROM traditional_chunks`;
    await sql`DELETE FROM facts_chunks`;

    // llm_chunks exists in the DB but is not in schema.ts — handle gracefully
    try {
      await sql`DELETE FROM llm_chunks`;
    } catch {
      // table may not exist yet
    }

    await sql`DELETE FROM documents`;
    await sql`DELETE FROM test_queries`;
    await sql`DELETE FROM rag_models`;

    return json({ ok: true });
  } catch (error) {
    console.error('Nuke error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Nuke failed' },
      { status: 500 }
    );
  }
};
