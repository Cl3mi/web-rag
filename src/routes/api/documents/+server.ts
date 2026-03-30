/**
 * Documents API Endpoint
 *
 * GET /api/documents?q=<text>
 * List documents. When q is provided, filters to documents whose title/url/domain
 * or any chunk content (across all three pipelines) contains the query.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim() ?? '';

  try {
    let rows: Record<string, unknown>[];

    if (q) {
      const like = `%${q}%`;

      // Try including llm_chunks; fall back without it if the table doesn't exist yet.
      try {
        rows = await sql.unsafe(
          `
          SELECT
            d.id, d.url, d.title, d.domain, d.created_at, d.updated_at,
            COUNT(DISTINCT tc.id) AS chunk_count,
            COUNT(DISTINCT fc.id) AS fact_count
          FROM documents d
          LEFT JOIN traditional_chunks tc ON tc.document_id = d.id
          LEFT JOIN facts_chunks fc ON fc.document_id = d.id
          WHERE (
            d.title        ILIKE $1 OR
            d.url          ILIKE $1 OR
            d.domain       ILIKE $1 OR
            EXISTS (SELECT 1 FROM traditional_chunks WHERE document_id = d.id AND content_markdown ILIKE $1) OR
            EXISTS (SELECT 1 FROM facts_chunks       WHERE document_id = d.id AND content           ILIKE $1) OR
            EXISTS (SELECT 1 FROM llm_chunks         WHERE document_id = d.id AND (summary ILIKE $1 OR original_content ILIKE $1))
          )
          GROUP BY d.id, d.url, d.title, d.domain, d.created_at, d.updated_at
          ORDER BY d.updated_at DESC
          LIMIT 500
          `,
          [like]
        );
      } catch {
        // llm_chunks table may not exist yet
        rows = await sql.unsafe(
          `
          SELECT
            d.id, d.url, d.title, d.domain, d.created_at, d.updated_at,
            COUNT(DISTINCT tc.id) AS chunk_count,
            COUNT(DISTINCT fc.id) AS fact_count
          FROM documents d
          LEFT JOIN traditional_chunks tc ON tc.document_id = d.id
          LEFT JOIN facts_chunks fc ON fc.document_id = d.id
          WHERE (
            d.title  ILIKE $1 OR
            d.url    ILIKE $1 OR
            d.domain ILIKE $1 OR
            EXISTS (SELECT 1 FROM traditional_chunks WHERE document_id = d.id AND content_markdown ILIKE $1) OR
            EXISTS (SELECT 1 FROM facts_chunks       WHERE document_id = d.id AND content           ILIKE $1)
          )
          GROUP BY d.id, d.url, d.title, d.domain, d.created_at, d.updated_at
          ORDER BY d.updated_at DESC
          LIMIT 500
          `,
          [like]
        );
      }
    } else {
      rows = await sql`
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
    }

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

    const documents = rows.map((row) => ({
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
