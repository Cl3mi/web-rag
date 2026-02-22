/**
 * Facts Pipeline Retriever
 *
 * Pure vector search using pgvector for facts.
 */

import { sql } from '$lib/server/db/client';
import { embedDense } from '$lib/server/embeddings/bge-m3';
import { VECTOR_SEARCH_DEFAULTS } from '$lib/config/database';
import type { SearchResult, FactCategory } from '$lib/types';

export interface FactRetrievalOptions {
  topK?: number;
  minScore?: number;
  minConfidence?: number;
  categories?: FactCategory[];
  documentIds?: string[];
}

const defaultOptions = {
  topK: VECTOR_SEARCH_DEFAULTS.matchCount,
  minScore: VECTOR_SEARCH_DEFAULTS.similarityThreshold,
  minConfidence: 0.5,
};

/**
 * Perform vector search on facts
 */
export async function searchFacts(
  query: string,
  options: FactRetrievalOptions = {}
): Promise<SearchResult[]> {
  const opts = { ...defaultOptions, ...options };

  // Get query embedding
  const queryEmbedding = await embedDense(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Build filters
  const filters: string[] = ['fc.dense_embedding IS NOT NULL'];

  if (opts.minConfidence) {
    filters.push(`fc.confidence >= ${opts.minConfidence}`);
  }

  if (opts.categories?.length) {
    const categoryList = opts.categories.map((c) => `'${c}'`).join(',');
    filters.push(`fc.category IN (${categoryList})`);
  }

  if (opts.documentIds?.length) {
    const docList = opts.documentIds.map((id) => `'${id}'::uuid`).join(',');
    filters.push(`fc.document_id = ANY(ARRAY[${docList}])`);
  }

  const whereClause = filters.join(' AND ');

  // Vector search
  const results = await sql`
    SELECT
      fc.id,
      fc.document_id,
      fc.content,
      fc.category,
      fc.confidence,
      fc.source_context,
      fc.metadata,
      fc.fact_index,
      d.url as source_url,
      d.title as source_title,
      1 - (fc.dense_embedding <=> ${embeddingStr}::vector) as score
    FROM facts_chunks fc
    JOIN documents d ON fc.document_id = d.id
    WHERE ${sql.unsafe(whereClause)}
    ORDER BY fc.dense_embedding <=> ${embeddingStr}::vector
    LIMIT ${opts.topK}
  `;

  return results
    .filter((r) => (r.score as number) >= opts.minScore)
    .map((r) => ({
      id: r.id as string,
      content: r.content as string,
      score: r.score as number,
      documentId: r.document_id as string,
      metadata: {
        category: r.category as string,
        confidence: r.confidence as number,
        sourceContext: r.source_context as string,
        ...(r.metadata as Record<string, unknown>),
      },
      sourceUrl: r.source_url as string,
      sourceTitle: r.source_title as string | null,
    }));
}

/**
 * Get fact by ID
 */
export async function getFactById(factId: string): Promise<SearchResult | null> {
  const results = await sql`
    SELECT
      fc.id,
      fc.document_id,
      fc.content,
      fc.category,
      fc.confidence,
      fc.source_context,
      fc.metadata,
      d.url as source_url,
      d.title as source_title
    FROM facts_chunks fc
    JOIN documents d ON fc.document_id = d.id
    WHERE fc.id = ${factId}
  `;

  if (results.length === 0) return null;

  const r = results[0];
  return {
    id: r.id as string,
    content: r.content as string,
    score: 1.0,
    documentId: r.document_id as string,
    metadata: {
      category: r.category as string,
      confidence: r.confidence as number,
      sourceContext: r.source_context as string,
      ...(r.metadata as Record<string, unknown>),
    },
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string | null,
  };
}

/**
 * Get all facts for a document
 */
export async function getFactsByDocumentId(documentId: string): Promise<SearchResult[]> {
  const results = await sql`
    SELECT
      fc.id,
      fc.document_id,
      fc.content,
      fc.category,
      fc.confidence,
      fc.source_context,
      fc.metadata,
      fc.fact_index,
      d.url as source_url,
      d.title as source_title
    FROM facts_chunks fc
    JOIN documents d ON fc.document_id = d.id
    WHERE fc.document_id = ${documentId}
    ORDER BY fc.fact_index
  `;

  return results.map((r) => ({
    id: r.id as string,
    content: r.content as string,
    score: 1.0,
    documentId: r.document_id as string,
    metadata: {
      category: r.category as string,
      confidence: r.confidence as number,
      sourceContext: r.source_context as string,
      ...(r.metadata as Record<string, unknown>),
    },
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string | null,
  }));
}

/**
 * Count total facts
 */
export async function countFacts(): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM facts_chunks
  `;
  return Number(result[0].count);
}

/**
 * Count facts by document
 */
export async function countFactsByDocument(documentId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM facts_chunks
    WHERE document_id = ${documentId}
  `;
  return Number(result[0].count);
}

/**
 * Get category distribution
 */
export async function getCategoryDistribution(): Promise<Record<string, number>> {
  const results = await sql`
    SELECT category, COUNT(*) as count
    FROM facts_chunks
    GROUP BY category
  `;

  const distribution: Record<string, number> = {};
  for (const row of results) {
    distribution[row.category as string] = Number(row.count);
  }

  return distribution;
}

/**
 * Get facts by category
 */
export async function getFactsByCategory(
  category: FactCategory,
  limit: number = 50
): Promise<SearchResult[]> {
  const results = await sql`
    SELECT
      fc.id,
      fc.document_id,
      fc.content,
      fc.category,
      fc.confidence,
      fc.source_context,
      fc.metadata,
      d.url as source_url,
      d.title as source_title
    FROM facts_chunks fc
    JOIN documents d ON fc.document_id = d.id
    WHERE fc.category = ${category}
    ORDER BY fc.confidence DESC
    LIMIT ${limit}
  `;

  return results.map((r) => ({
    id: r.id as string,
    content: r.content as string,
    score: r.confidence as number,
    documentId: r.document_id as string,
    metadata: {
      category: r.category as string,
      confidence: r.confidence as number,
      sourceContext: r.source_context as string,
      ...(r.metadata as Record<string, unknown>),
    },
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string | null,
  }));
}
