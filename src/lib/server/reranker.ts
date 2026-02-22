/**
 * Reranker Service
 *
 * Cross-encoder reranking using BGE reranker model.
 * Falls back to score-based reranking if model not available.
 */

import { pipeline } from '@xenova/transformers';
import type { SearchResult } from '$lib/types';

// Pipeline type
type RerankerPipeline = Awaited<ReturnType<typeof pipeline>>;

// Singleton state
let rerankerPipeline: RerankerPipeline | null = null;
let loadingPromise: Promise<void> | null = null;
let modelLoaded = false;

// Model configuration
const RERANKER_MODEL = 'Xenova/bge-reranker-base';
const DEFAULT_THRESHOLD = 0.3;

/**
 * Initialize the reranker model
 */
async function initializeModel(): Promise<void> {
  if (rerankerPipeline) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    console.log(`Loading reranker model: ${RERANKER_MODEL}...`);

    try {
      rerankerPipeline = await pipeline(
        'text-classification',
        RERANKER_MODEL
      );

      modelLoaded = true;
      console.log('Reranker model loaded successfully');
    } catch (error) {
      console.warn('Failed to load reranker model, will use score-based ranking:', error);
      // Not throwing - we'll fall back to score-based ranking
    }
  })();

  await loadingPromise;
}

/**
 * Rerank results using cross-encoder
 */
export async function rerank(
  query: string,
  results: SearchResult[],
  options: {
    topK?: number;
    threshold?: number;
  } = {}
): Promise<SearchResult[]> {
  const { topK = results.length, threshold = DEFAULT_THRESHOLD } = options;

  if (results.length === 0) return [];

  // Try to use model-based reranking
  try {
    await initializeModel();

    if (rerankerPipeline) {
      return await rerankWithModel(query, results, topK, threshold);
    }
  } catch (error) {
    console.warn('Reranking failed, using original scores:', error);
  }

  // Fall back to score-based ranking
  return rerankByScore(results, topK, threshold);
}

/**
 * Rerank using cross-encoder model
 */
async function rerankWithModel(
  query: string,
  results: SearchResult[],
  topK: number,
  threshold: number
): Promise<SearchResult[]> {
  if (!rerankerPipeline) {
    throw new Error('Reranker pipeline not initialized');
  }

  // Create query-document pairs
  const pairs = results.map((result) => ({
    text: `${query} [SEP] ${result.content}`,
    result,
  }));

  // Score each pair
  const scoredResults: Array<{ result: SearchResult; rerankScore: number }> = [];

  for (const pair of pairs) {
    try {
      const output = await (rerankerPipeline as (
        text: string
      ) => Promise<Array<{ label: string; score: number }>>)(pair.text);

      // Extract score (model outputs positive/negative classification)
      let score = 0;
      if (Array.isArray(output) && output.length > 0) {
        // Find the positive/relevant label score
        const positiveLabel = output.find(
          (o) => o.label.toLowerCase().includes('positive') || o.label === 'LABEL_1'
        );
        score = positiveLabel?.score ?? output[0].score;
      }

      scoredResults.push({
        result: pair.result,
        rerankScore: score,
      });
    } catch (error) {
      // On error, use original score
      scoredResults.push({
        result: pair.result,
        rerankScore: pair.result.score,
      });
    }
  }

  // Sort by rerank score and filter by threshold
  scoredResults.sort((a, b) => b.rerankScore - a.rerankScore);

  return scoredResults
    .filter((r) => r.rerankScore >= threshold)
    .slice(0, topK)
    .map((r) => ({
      ...r.result,
      score: r.rerankScore,
    }));
}

/**
 * Rerank using original scores (fallback)
 */
function rerankByScore(
  results: SearchResult[],
  topK: number,
  threshold: number
): SearchResult[] {
  return results
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Check if reranker model is loaded
 */
export function isRerankerLoaded(): boolean {
  return modelLoaded;
}

/**
 * Preload the reranker model
 */
export async function preloadReranker(): Promise<void> {
  await initializeModel();
}

/**
 * Simple reciprocal rank fusion for combining results from multiple sources
 */
export function reciprocalRankFusion(
  resultSets: SearchResult[][],
  k: number = 60
): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const result = results[rank];
      const rrfScore = 1 / (k + rank + 1);

      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrfScore;
        // Keep the result with higher original score
        if (result.score > existing.result.score) {
          existing.result = result;
        }
      } else {
        scoreMap.set(result.id, { result, score: rrfScore });
      }
    }
  }

  // Sort by RRF score
  const fused = [...scoreMap.values()];
  fused.sort((a, b) => b.score - a.score);

  return fused.map((f) => ({
    ...f.result,
    score: f.score,
  }));
}

/**
 * Diversity-aware reranking using MMR (Maximal Marginal Relevance)
 */
export function maximalMarginalRelevance(
  results: SearchResult[],
  embeddings: number[][],
  lambda: number = 0.5,
  topK: number = 10
): SearchResult[] {
  if (results.length === 0) return [];
  if (results.length <= topK) return results;

  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  // Select first result (highest relevance)
  const firstIdx = results.reduce((maxIdx, r, idx, arr) =>
    r.score > arr[maxIdx].score ? idx : maxIdx, 0);
  selected.push(firstIdx);
  remaining.delete(firstIdx);

  // Iteratively select remaining
  while (selected.length < topK && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      // Calculate relevance score (original score)
      const relevance = results[idx].score;

      // Calculate max similarity to selected results
      let maxSim = 0;
      for (const selIdx of selected) {
        const sim = cosineSimilarity(embeddings[idx], embeddings[selIdx]);
        maxSim = Math.max(maxSim, sim);
      }

      // MMR score
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }

  return selected.map((idx) => results[idx]);
}

/**
 * Cosine similarity helper
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
