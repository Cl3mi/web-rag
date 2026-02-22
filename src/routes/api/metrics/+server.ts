/**
 * Metrics API Endpoint
 *
 * GET /api/metrics
 * Returns real-time stats: document counts, chunk counts per pipeline.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

export const GET: RequestHandler = async () => {
  try {
    // Get counts in parallel (llm_chunks might not exist yet)
    let llmCount = [{ count: 0 }];
    try {
      llmCount = await sql`SELECT COUNT(*) as count FROM llm_chunks`;
    } catch {
      // Table doesn't exist yet, use 0
    }

    const [
      documentCount,
      chunkCount,
      factCount,
      domainStats,
      categoryDistribution,
      recentDocuments,
    ] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM documents`,
      sql`SELECT COUNT(*) as count FROM traditional_chunks`,
      sql`SELECT COUNT(*) as count FROM facts_chunks`,
      sql`
        SELECT
          domain,
          COUNT(*) as document_count,
          MAX(updated_at) as last_updated
        FROM documents
        GROUP BY domain
        ORDER BY document_count DESC
        LIMIT 10
      `,
      sql`
        SELECT category, COUNT(*) as count
        FROM facts_chunks
        GROUP BY category
      `,
      sql`
        SELECT id, url, title, domain, created_at, updated_at
        FROM documents
        ORDER BY updated_at DESC
        LIMIT 5
      `,
    ]);

    // Get average stats for all pipeline types
    const avgStats = await sql`
      SELECT
        AVG(chunk_count) as avg_chunks,
        AVG(fact_count) as avg_facts,
        AVG(llm_count) as avg_llm
      FROM (
        SELECT
          d.id,
          COUNT(DISTINCT tc.id) as chunk_count,
          COUNT(DISTINCT fc.id) as fact_count,
          COUNT(DISTINCT lc.id) as llm_count
        FROM documents d
        LEFT JOIN traditional_chunks tc ON d.id = tc.document_id
        LEFT JOIN facts_chunks fc ON d.id = fc.document_id
        LEFT JOIN llm_chunks lc ON d.id = lc.document_id
        GROUP BY d.id
      ) subquery
    `;

    // Build category distribution map
    const categories: Record<string, number> = {};
    for (const row of categoryDistribution) {
      categories[row.category as string] = Number(row.count);
    }

    return json({
      overview: {
        totalDocuments: Number(documentCount[0]?.count ?? 0),
        totalChunks: Number(chunkCount[0]?.count ?? 0),
        totalFacts: Number(factCount[0]?.count ?? 0),
        totalLLMChunks: Number(llmCount[0]?.count ?? 0),
        avgChunksPerDoc: Number(avgStats[0]?.avg_chunks ?? 0) || 0,
        avgFactsPerDoc: Number(avgStats[0]?.avg_facts ?? 0) || 0,
        avgLLMPerDoc: Number(avgStats[0]?.avg_llm ?? 0) || 0,
      },
      domains: domainStats.map((row) => ({
        domain: row.domain as string,
        documentCount: Number(row.document_count),
        lastUpdated: row.last_updated as Date,
      })),
      factsCategories: categories,
      recentDocuments: recentDocuments.map((row) => ({
        id: row.id as string,
        url: row.url as string,
        title: row.title as string | null,
        domain: row.domain as string,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
      })),
    });
  } catch (error) {
    console.error('Metrics error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
