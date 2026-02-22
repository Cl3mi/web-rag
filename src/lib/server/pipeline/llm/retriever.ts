/**
 * LLM Chunks Retriever
 *
 * Vector similarity search over LLM-summarized chunks.
 * Returns both summary and original content for context.
 */

import { sql } from '$lib/server/db/client';
import { embedDense } from '$lib/server/embeddings/bge-m3';
import type { SearchResult } from '$lib/types';

export interface LLMSearchOptions {
  topK?: number;
  minScore?: number;
}

const DEFAULT_OPTIONS: Required<LLMSearchOptions> = {
  topK: 10,
  minScore: 0.3,
};

/**
 * Search LLM chunks using vector similarity
 */
export async function searchLLMChunks(
  query: string,
  options: LLMSearchOptions = {}
): Promise<SearchResult[]> {
  const { topK, minScore } = { ...DEFAULT_OPTIONS, ...options };

  // Get query embedding
  const queryEmbedding = await embedDense(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Vector similarity search
  const results = await sql`
    SELECT
      lc.id,
      lc.document_id,
      lc.chunk_index,
      lc.original_content,
      lc.summary,
      lc.metadata,
      d.url as source_url,
      d.title as source_title,
      1 - (lc.dense_embedding <=> ${embeddingStr}::vector) as similarity
    FROM llm_chunks lc
    JOIN documents d ON lc.document_id = d.id
    WHERE lc.dense_embedding IS NOT NULL
    ORDER BY lc.dense_embedding <=> ${embeddingStr}::vector
    LIMIT ${topK * 2}
  `;

  // Filter by minimum score and format results
  const filtered = results
    .filter((r) => (r.similarity as number) >= minScore)
    .slice(0, topK);

  return filtered.map((r) => ({
    id: r.id as string,
    // Return summary + original for richer context
    content: `Summary: ${r.summary}\n\nDetails: ${r.original_content}`,
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
