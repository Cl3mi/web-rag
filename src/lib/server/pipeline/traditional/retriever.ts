/**
 * Traditional Pipeline Retriever
 *
 * Hybrid search combining dense (pgvector) and sparse (BM25) retrieval.
 */

import { sql } from '$lib/server/db/client';
import { embed, sparseSimilarity } from '$lib/server/embeddings/bge-m3';
import { VECTOR_SEARCH_DEFAULTS, EMBEDDING_DIMENSION } from '$lib/config/database';
import type { SearchResult } from '$lib/types';

export interface RetrievalOptions {
  topK?: number;
  alpha?: number; // Weight for dense similarity (1 - alpha for sparse)
  minScore?: number;
  documentIds?: string[]; // Filter to specific documents
}

const defaultOptions: Required<Omit<RetrievalOptions, 'documentIds'>> = {
  topK: VECTOR_SEARCH_DEFAULTS.matchCount,
  alpha: VECTOR_SEARCH_DEFAULTS.hybridAlpha,
  minScore: VECTOR_SEARCH_DEFAULTS.similarityThreshold,
};

/**
 * Perform hybrid search combining dense and sparse retrieval
 */
export async function hybridSearch(
  query: string,
  options: RetrievalOptions = {}
): Promise<SearchResult[]> {
  const opts = { ...defaultOptions, ...options };

  // Get query embeddings
  const queryEmbedding = await embed(query);

  // Format embedding for pgvector
  const embeddingStr = `[${queryEmbedding.dense.join(',')}]`;

  // Build document filter if specified
  const docFilter = opts.documentIds?.length
    ? `AND tc.document_id = ANY(ARRAY[${opts.documentIds.map((id) => `'${id}'::uuid`).join(',')}])`
    : '';

  // Fetch more results for hybrid reranking.
  // A larger pool gives the sparse BM25 component a fair chance to surface
  // keyword-relevant documents that rank low on dense (semantic) similarity.
  const fetchCount = opts.topK * 10;

  // Dense vector search using pgvector
  const results = await sql`
    SELECT
      tc.id,
      tc.document_id,
      tc.content,
      tc.content_markdown,
      tc.sparse_vector,
      tc.metadata,
      tc.chunk_index,
      d.url as source_url,
      d.title as source_title,
      1 - (tc.dense_embedding <=> ${embeddingStr}::vector) as dense_score
    FROM traditional_chunks tc
    JOIN documents d ON tc.document_id = d.id
    WHERE tc.dense_embedding IS NOT NULL
    ${sql.unsafe(docFilter)}
    ORDER BY tc.dense_embedding <=> ${embeddingStr}::vector
    LIMIT ${fetchCount}
  `;

  // Calculate hybrid scores
  const scoredResults = results.map((row) => {
    const sparseVector = (row.sparse_vector as Record<string, number>) || {};
    const sparseScore = sparseSimilarity(queryEmbedding.sparse, sparseVector);
    const denseScore = row.dense_score as number;

    // Hybrid score
    const hybridScore = opts.alpha * denseScore + (1 - opts.alpha) * sparseScore;

    return {
      id: row.id as string,
      documentId: row.document_id as string,
      content: row.content as string,
      contentMarkdown: row.content_markdown as string,
      metadata: row.metadata as Record<string, unknown>,
      sourceUrl: row.source_url as string,
      sourceTitle: row.source_title as string | null,
      denseScore,
      sparseScore,
      score: hybridScore,
    };
  });

  // Sort by hybrid score and take top K
  scoredResults.sort((a, b) => b.score - a.score);
  const topResults = scoredResults.slice(0, opts.topK);

  // Filter by minimum score
  const filteredResults = topResults.filter((r) => r.score >= opts.minScore);

  // Convert to SearchResult format
  return filteredResults.map((r) => ({
    id: r.id,
    content: r.content,
    score: r.score,
    documentId: r.documentId,
    metadata: r.metadata,
    sourceUrl: r.sourceUrl,
    sourceTitle: r.sourceTitle,
  }));
}

/**
 * Perform pure dense vector search
 */
export async function denseSearch(
  query: string,
  options: RetrievalOptions = {}
): Promise<SearchResult[]> {
  const opts = { ...defaultOptions, ...options };

  const queryEmbedding = await embed(query);
  const embeddingStr = `[${queryEmbedding.dense.join(',')}]`;

  const docFilter = opts.documentIds?.length
    ? `AND tc.document_id = ANY(ARRAY[${opts.documentIds.map((id) => `'${id}'::uuid`).join(',')}])`
    : '';

  const results = await sql`
    SELECT
      tc.id,
      tc.document_id,
      tc.content,
      tc.metadata,
      d.url as source_url,
      d.title as source_title,
      1 - (tc.dense_embedding <=> ${embeddingStr}::vector) as score
    FROM traditional_chunks tc
    JOIN documents d ON tc.document_id = d.id
    WHERE tc.dense_embedding IS NOT NULL
    ${sql.unsafe(docFilter)}
    ORDER BY tc.dense_embedding <=> ${embeddingStr}::vector
    LIMIT ${opts.topK}
  `;

  return results
    .filter((r) => (r.score as number) >= opts.minScore)
    .map((r) => ({
      id: r.id as string,
      content: r.content as string,
      score: r.score as number,
      documentId: r.document_id as string,
      metadata: r.metadata as Record<string, unknown>,
      sourceUrl: r.source_url as string,
      sourceTitle: r.source_title as string | null,
    }));
}

/**
 * Get chunk by ID
 */
export async function getChunkById(chunkId: string): Promise<SearchResult | null> {
  const results = await sql`
    SELECT
      tc.id,
      tc.document_id,
      tc.content,
      tc.metadata,
      d.url as source_url,
      d.title as source_title
    FROM traditional_chunks tc
    JOIN documents d ON tc.document_id = d.id
    WHERE tc.id = ${chunkId}
  `;

  if (results.length === 0) return null;

  const r = results[0];
  return {
    id: r.id as string,
    content: r.content as string,
    score: 1.0,
    documentId: r.document_id as string,
    metadata: r.metadata as Record<string, unknown>,
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string | null,
  };
}

/**
 * Get all chunks for a document
 */
export async function getChunksByDocumentId(documentId: string): Promise<SearchResult[]> {
  const results = await sql`
    SELECT
      tc.id,
      tc.document_id,
      tc.content,
      tc.metadata,
      tc.chunk_index,
      d.url as source_url,
      d.title as source_title
    FROM traditional_chunks tc
    JOIN documents d ON tc.document_id = d.id
    WHERE tc.document_id = ${documentId}
    ORDER BY tc.chunk_index
  `;

  return results.map((r) => ({
    id: r.id as string,
    content: r.content as string,
    score: 1.0,
    documentId: r.document_id as string,
    metadata: r.metadata as Record<string, unknown>,
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string | null,
  }));
}

/**
 * Count total chunks
 */
export async function countChunks(): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM traditional_chunks
  `;
  return Number(result[0].count);
}

/**
 * Count chunks by document
 */
export async function countChunksByDocument(documentId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM traditional_chunks
    WHERE document_id = ${documentId}
  `;
  return Number(result[0].count);
}
