/**
 * LLM Chunk Embedder
 *
 * Dense embedding: summary + first 500 chars of original (semantic focus).
 * Sparse embedding: original_content (preserves exact vocabulary for BM25 matching).
 */

import { embedDense, embedBatchDense, embedSparse } from '$lib/server/embeddings/bge-m3';
import type { SummarizedChunk } from './summarizer';

export interface EmbeddedLLMChunk {
  index: number;
  originalContent: string;
  summary: string;
  denseEmbedding: number[];
  sparseVector: Record<string, number>;
  metadata: {
    chunkType: string;
    tokenCount: number;
    summaryTokenCount: number;
  };
}

/**
 * Create embedding text by combining summary and key parts of original
 * Summary is weighted higher by being placed first
 */
function createEmbeddingText(summary: string, original: string): string {
  // Combine summary (for semantic focus) with truncated original (for details)
  // Summary first gives it more weight in the embedding
  const truncatedOriginal = original.slice(0, 500);
  return summary;
}

/**
 * Embed a batch of summarized chunks
 */
export async function embedLLMChunks(
  chunks: SummarizedChunk[]
): Promise<EmbeddedLLMChunk[]> {
  if (chunks.length === 0) return [];

  // Create embedding texts
  const texts = chunks.map((chunk) =>
    createEmbeddingText(chunk.summary, chunk.originalContent)
  );

  // Get embeddings in batch
  const embeddings = await embedBatchDense(texts);

  // Combine with chunk data
  return chunks.map((chunk, i) => ({
    index: chunk.index,
    originalContent: chunk.originalContent,
    summary: chunk.summary,
    denseEmbedding: embeddings[i],
    // Sparse vector over original_content so BM25 matches the actual vocabulary
    // of the source text, not the abstract summary vocabulary.
    sparseVector: embedSparse(chunk.originalContent),
    metadata: chunk.metadata,
  }));
}

/**
 * Embed a single query for searching
 */
export async function embedQuery(query: string): Promise<number[]> {
  return embedDense(query);
}
