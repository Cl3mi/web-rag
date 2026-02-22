/**
 * Facts Pipeline Embedder
 *
 * Generates dense embeddings only (no sparse vectors) for atomic facts.
 */

import { embedDense, embedBatchDense } from '$lib/server/embeddings/bge-m3';
import type { ExtractedFact } from './extractor';

export interface FactWithEmbedding extends ExtractedFact {
  factIndex: number;
  denseEmbedding: number[];
}

/**
 * Embed a single fact
 */
export async function embedFact(
  fact: ExtractedFact,
  factIndex: number
): Promise<FactWithEmbedding> {
  const embedding = await embedDense(fact.content);

  return {
    ...fact,
    factIndex,
    denseEmbedding: embedding,
  };
}

/**
 * Embed multiple facts
 */
export async function embedFacts(facts: ExtractedFact[]): Promise<FactWithEmbedding[]> {
  if (facts.length === 0) return [];

  const texts = facts.map((fact) => fact.content);
  const embeddings = await embedBatchDense(texts);

  return facts.map((fact, i) => ({
    ...fact,
    factIndex: i,
    denseEmbedding: embeddings[i],
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
