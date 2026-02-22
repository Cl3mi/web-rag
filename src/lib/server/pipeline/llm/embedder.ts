/**
 * LLM Chunk Embedder
 *
 * Embeds the combination of summary + original content for better retrieval.
 * The summary provides semantic focus while the original preserves details.
 */

import { embedDense, embedBatchDense } from '$lib/server/embeddings/bge-m3';
import type { SummarizedChunk } from './summarizer';

export interface EmbeddedLLMChunk {
  index: number;
  originalContent: string;
  summary: string;
  denseEmbedding: number[];
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
  return `${summary}\n\n${truncatedOriginal}`;
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
    metadata: chunk.metadata,
  }));
}

/**
 * Embed a single query for searching
 */
export async function embedQuery(query: string): Promise<number[]> {
  return embedDense(query);
}
