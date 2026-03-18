/**
 * Documents API Endpoint
 *
 * GET /api/documents
 * List all indexed documents for selection.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

/**
 * GET /api/documents
 * Get all documents with basic info for selection
 */
export const GET: RequestHandler = async () => {
  try {
    const rows = await sql`
      SELECT
        d.id, d.url, d.title, d.domain, d.created_at, d.updated_at,
        COUNT(DISTINCT tc.id) AS chunk_count,
        COUNT(DISTINCT fc.id) AS fact_count
      FROM documents d
      LEFT JOIN traditional_chunks tc ON tc.document_id = d.id
      LEFT JOIN facts_chunks fc ON fc.document_id = d.id
      GROUP BY d.id, d.url, d.title, d.domain, d.created_at, d.updated_at
      ORDER BY d.updated_at DESC
      LIMIT 500
    `;

    // Fetch LLM counts separately (table may not exist yet)
    let llmCounts: Record<string, number> = {};
    try {
      const llmRows = await sql`
        SELECT document_id, COUNT(*) AS cnt FROM llm_chunks GROUP BY document_id
      `;
      for (const r of llmRows) {
        llmCounts[r.document_id as string] = Number(r.cnt);
      }
    } catch { /* llm_chunks table not yet created */ }

    // Map to camelCase for frontend
    const documents = rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      domain: row.domain,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      chunkCount: Number(row.chunk_count),
      factCount: Number(row.fact_count),
      llmCount: llmCounts[row.id as string] ?? 0,
    }));

    return json({ documents });
  } catch (error) {
    console.error('Get documents error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
