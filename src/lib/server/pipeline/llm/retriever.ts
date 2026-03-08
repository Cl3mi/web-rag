/**
 * LLM Chunks Retriever
 *
 * Vector similarity search over LLM-summarized chunks.
 * Returns both summary and original content for context.
 */

import { sql } from '$lib/server/db/client';
import { embed, sparseSimilarity } from '$lib/server/embeddings/bge-m3';
import { VECTOR_SEARCH_DEFAULTS } from '$lib/config/database';
import type { SearchResult } from '$lib/types';

export interface LLMSearchOptions {
  topK?: number;
  minScore?: number;
}

const DEFAULT_OPTIONS: Required<LLMSearchOptions> = {
  topK: 10,
  minScore: 0.1,
};

/**
 * Search LLM chunks using vector similarity
 */
export async function searchLLMChunks(
  query: string,
  options: LLMSearchOptions = {}
): Promise<SearchResult[]> {
  const { topK, minScore } = { ...DEFAULT_OPTIONS, ...options };

  // Get query embedding (dense + sparse for hybrid search)
  const queryEmbedding = await embed(query);
  const embeddingStr = `[${queryEmbedding.dense.join(',')}]`;

  // Fetch larger candidate pool for hybrid re-ranking
  const fetchCount = topK * 10;

  // Dense vector search — candidate pool
  const results = await sql`
    SELECT
      lc.id,
      lc.document_id,
      lc.chunk_index,
      lc.original_content,
      lc.summary,
      lc.sparse_vector,
      lc.metadata,
      d.url as source_url,
      d.title as source_title,
      1 - (lc.dense_embedding <=> ${embeddingStr}::vector) as dense_score
    FROM llm_chunks lc
    JOIN documents d ON lc.document_id = d.id
    WHERE lc.dense_embedding IS NOT NULL
    ORDER BY lc.dense_embedding <=> ${embeddingStr}::vector
    LIMIT ${fetchCount}
  `;

  // Hybrid re-ranking: alpha * dense + (1 - alpha) * sparse
  const alpha = VECTOR_SEARCH_DEFAULTS.hybridAlpha;
  const scored = results.map((r) => {
    const denseScore = r.dense_score as number;
    const sparseScore = sparseSimilarity(
      queryEmbedding.sparse,
      (r.sparse_vector as Record<string, number>) || {}
    );
    return { ...r, similarity: alpha * denseScore + (1 - alpha) * sparseScore };
  });

  scored.sort((a, b) => b.similarity - a.similarity);

  // Filter by minimum score and format results
  const filtered = scored
    .filter((r) => r.similarity >= minScore)
    .slice(0, topK);

  return filtered.map((r) => ({
    id: r.id as string,
    // Use original_content as context — the embedding was trained on
    // summary+original (good retrieval), but the generated summary is too
    // lossy (1-2 sentences) for the LLM and judge to answer specific fact
    // queries. Serving original_content gives the full detail needed while
    // the context window limit (8 000 chars) provides natural length control.
    content: r.original_content as string,
    score: r.similarity as number,
    documentId: r.document_id as string,
    metadata: {
      ...(r.metadata as Record<string, unknown>),
      summary: r.summary,
      chunkIndex: r.chunk_index,
    },
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string | null,
  }));
}

/**
 * Get all LLM chunks for a document
 */
export async function getLLMChunksForDocument(
  documentId: string
): Promise<Array<{ id: string; summary: string; originalContent: string }>> {
  const results = await sql`
    SELECT id, summary, original_content
    FROM llm_chunks
    WHERE document_id = ${documentId}
    ORDER BY chunk_index
  `;

  return results.map((r) => ({
    id: r.id as string,
    summary: r.summary as string,
    originalContent: r.original_content as string,
  }));
}
