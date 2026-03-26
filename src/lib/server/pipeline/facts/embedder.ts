/**
 * Facts Pipeline Embedder
 *
 * Generates dense + sparse embeddings for atomic facts.
 *
 * Contextual Retrieval (Anthropic 2024):
 *   Dense embedding target = "[{heading}] {content}" when a section heading is known.
 *   This bakes document structure into the vector so that queries using different
 *   terminology from the fact's text (e.g. "student products" vs "U27 Fonds-Sparplan")
 *   can still match via the heading context. The stored content stays as the bare
 *   atomic sentence — only the embedding vector is enriched.
 *
 * Sparse (BM25-style) is computed from sourceContext (heading + ±1 surrounding sentences)
 * to give keyword matching a richer signal than the bare fact sentence alone.
 */

import { embedDense, embedBatchDense, embedSparse } from '$lib/server/embeddings/bge-m3';
import type { ExtractedFact } from './extractor';

export interface FactWithEmbedding extends ExtractedFact {
  factIndex: number;
  denseEmbedding: number[];
  sparseVector: Record<string, number>;
}

/**
 * Build the text used for dense embedding (Contextual Retrieval pattern).
 * Prepends the section heading when available so that terminology mismatches
 * (e.g. "student" vs "U27") are bridged at the vector level.
 * The stored fact.content is never modified — only the embedding target changes.
 */
function denseEmbeddingText(fact: ExtractedFact): string {
  return fact.metadata.heading
    ? `[${fact.metadata.heading}] ${fact.content}`
    : fact.content;
}

/**
 * Embed a single fact
 */
export async function embedFact(
  fact: ExtractedFact,
  factIndex: number
): Promise<FactWithEmbedding> {
  // Dense: contextual embedding target "[heading] sentence" when heading known.
  // Sparse: sourceContext (heading + ±1 surrounding sentence) for BM25 keyword matching.
  const embedding = await embedDense(denseEmbeddingText(fact));

  return {
    ...fact,
    factIndex,
    denseEmbedding: embedding,
    sparseVector: embedSparse(fact.sourceContext || fact.content),
  };
}

/**
 * Embed multiple facts
 */
export async function embedFacts(facts: ExtractedFact[]): Promise<FactWithEmbedding[]> {
  if (facts.length === 0) return [];

  // Dense: contextual "[heading] sentence" per fact. Sparse: sourceContext.
  const texts = facts.map(denseEmbeddingText);
  const embeddings = await embedBatchDense(texts);

  return facts.map((fact, i) => ({
    ...fact,
    factIndex: i,
    denseEmbedding: embeddings[i],
    sparseVector: embedSparse(fact.sourceContext || fact.content),
  }));
}

/**
 * Process and embed document facts
 * Returns facts with embeddings ready for database insertion
 */
export async function processFacts(
  facts: ExtractedFact[]
): Promise<FactWithEmbedding[]> {
  return embedFacts(facts);
}

/**
 * Get embedding statistics for a set of facts
 */
export function getFactStats(facts: FactWithEmbedding[]): {
  totalFacts: number;
  avgContentLength: number;
  avgConfidence: number;
  categoryCounts: Record<string, number>;
} {
  if (facts.length === 0) {
    return {
      totalFacts: 0,
      avgContentLength: 0,
      avgConfidence: 0,
      categoryCounts: {},
    };
  }

  const totalLength = facts.reduce((sum, fact) => sum + fact.content.length, 0);
  const totalConfidence = facts.reduce((sum, fact) => sum + fact.confidence, 0);

  const categoryCounts: Record<string, number> = {};
  for (const fact of facts) {
    categoryCounts[fact.category] = (categoryCounts[fact.category] || 0) + 1;
  }

  return {
    totalFacts: facts.length,
    avgContentLength: totalLength / facts.length,
    avgConfidence: totalConfidence / facts.length,
    categoryCounts,
  };
}
