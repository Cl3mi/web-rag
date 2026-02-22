/**
 * Traditional Pipeline Embedder
 *
 * Generates both dense (BGE-M3) and sparse (BM25) embeddings for chunks.
 */

import { embed, embedBatch } from '$lib/server/embeddings/bge-m3';
import type { Chunk } from './chunker';
import type { EmbeddingResult } from '$lib/types';

export interface ChunkWithEmbedding extends Chunk {
  denseEmbedding: number[];
  sparseVector: Record<string, number>;
}

/**
 * Embed a single chunk
 */
export async function embedChunk(chunk: Chunk): Promise<ChunkWithEmbedding> {
  const embedding = await embed(chunk.content);

  return {
    ...chunk,
    denseEmbedding: embedding.dense,
    sparseVector: embedding.sparse,
  };
}

/**
 * Embed multiple chunks
 */
export async function embedChunks(chunks: Chunk[]): Promise<ChunkWithEmbedding[]> {
  if (chunks.length === 0) return [];

  const texts = chunks.map((chunk) => chunk.content);
  const embeddings = await embedBatch(texts);

  return chunks.map((chunk, i) => ({
    ...chunk,
    denseEmbedding: embeddings[i].dense,
    sparseVector: embeddings[i].sparse,
  }));
}

/**
 * Process and embed document content
 * Returns chunks with embeddings ready for database insertion
 */
export async function processDocument(
  content: string,
  chunker: (text: string) => Chunk[]
): Promise<ChunkWithEmbedding[]> {
  // Chunk the content
  const chunks = chunker(content);

  // Embed all chunks
  const embeddedChunks = await embedChunks(chunks);

  return embeddedChunks;
}

/**
 * Get embedding statistics for a set of chunks
 */
export function getEmbeddingStats(chunks: ChunkWithEmbedding[]): {
  totalChunks: number;
  avgTokenCount: number;
  avgSparseTerms: number;
  totalTokens: number;
} {
  if (chunks.length === 0) {
    return {
      totalChunks: 0,
      avgTokenCount: 0,
      avgSparseTerms: 0,
      totalTokens: 0,
    };
  }

  const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.metadata.tokenCount, 0);
  const totalSparseTerms = chunks.reduce(
    (sum, chunk) => sum + Object.keys(chunk.sparseVector).length,
    0
  );

  return {
    totalChunks: chunks.length,
    avgTokenCount: totalTokens / chunks.length,
    avgSparseTerms: totalSparseTerms / chunks.length,
    totalTokens,
  };
}
