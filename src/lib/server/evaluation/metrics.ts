/**
 * Evaluation Metrics
 *
 * Implementation of standard IR evaluation metrics:
 * - Recall@K: Fraction of relevant docs in top K
 * - MRR: Mean Reciprocal Rank
 * - nDCG: Normalized Discounted Cumulative Gain
 * - Precision@K: Fraction of top K that are relevant
 */

import type { QueryMetrics, PipelineMetrics, SearchResult, DocumentCoverageMetrics, CompressionMetrics } from '$lib/types';

/**
 * Calculate Recall@K
 * Fraction of relevant documents that appear in the top K results
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevant - Set of relevant document IDs
 * @param k - Number of results to consider
 */
export function calculateRecallAtK(
  retrieved: string[],
  relevant: string[],
  k: number
): number {
  if (relevant.length === 0) return 0;

  const relevantSet = new Set(relevant);
  const topK = retrieved.slice(0, k);

  let hits = 0;
  for (const docId of topK) {
    if (relevantSet.has(docId)) {
      hits++;
    }
  }

  return hits / relevant.length;
}

/**
 * Calculate Precision@K
 * Fraction of top K results that are relevant
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevant - Set of relevant document IDs
 * @param k - Number of results to consider
 */
export function calculatePrecisionAtK(
  retrieved: string[],
  relevant: string[],
  k: number
): number {
  if (k === 0) return 0;

  const relevantSet = new Set(relevant);
  const topK = retrieved.slice(0, k);

  let hits = 0;
  for (const docId of topK) {
    if (relevantSet.has(docId)) {
      hits++;
    }
  }

  return hits / Math.min(k, topK.length);
}

/**
 * Calculate Mean Reciprocal Rank (MRR)
 * 1/rank of first relevant result
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevant - Set of relevant document IDs
 */
export function calculateMRR(
  retrieved: string[],
  relevant: string[]
): number {
  if (relevant.length === 0) return 0;

  const relevantSet = new Set(relevant);

  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }

  return 0;
}

/**
 * Calculate Discounted Cumulative Gain (DCG)
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevanceScores - Map of document ID to relevance score (higher = more relevant)
 * @param k - Number of results to consider
 */
export function calculateDCG(
  retrieved: string[],
  relevanceScores: Map<string, number>,
  k: number
): number {
  let dcg = 0;
  const topK = retrieved.slice(0, k);

  for (let i = 0; i < topK.length; i++) {
    const rel = relevanceScores.get(topK[i]) ?? 0;
    // Using log2(i + 2) as per standard DCG formula (position is 1-indexed)
    dcg += rel / Math.log2(i + 2);
  }

  return dcg;
}

/**
 * Calculate Ideal DCG
 * DCG of perfectly ranked results
 *
 * @param relevanceScores - Map of document ID to relevance score
 * @param k - Number of results to consider
 */
export function calculateIDCG(
  relevanceScores: Map<string, number>,
  k: number
): number {
  // Sort by relevance descending
  const sortedScores = [...relevanceScores.values()].sort((a, b) => b - a);
  const topK = sortedScores.slice(0, k);

  let idcg = 0;
  for (let i = 0; i < topK.length; i++) {
    idcg += topK[i] / Math.log2(i + 2);
  }

  return idcg;
}

/**
 * Calculate Normalized DCG (nDCG)
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevanceScores - Map of document ID to relevance score
 * @param k - Number of results to consider
 */
export function calculateNDCG(
  retrieved: string[],
  relevanceScores: Map<string, number>,
  k: number
): number {
  const dcg = calculateDCG(retrieved, relevanceScores, k);
  const idcg = calculateIDCG(relevanceScores, k);

  if (idcg === 0) return 0;
  return dcg / idcg;
}

/**
 * Calculate nDCG with binary relevance
 * Simpler version where all relevant docs have score 1
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevant - Set of relevant document IDs
 * @param k - Number of results to consider
 */
export function calculateNDCGBinary(
  retrieved: string[],
  relevant: string[],
  k: number
): number {
  const relevanceScores = new Map<string, number>();
  for (const docId of relevant) {
    relevanceScores.set(docId, 1);
  }

  return calculateNDCG(retrieved, relevanceScores, k);
}

/**
 * Calculate Hit@K
 * 1 if at least one relevant document appears in top K, 0 otherwise
 *
 * @param retrieved - Retrieved document IDs in order
 * @param relevant - Set of relevant document IDs
 * @param k - Number of results to consider
 */
export function calculateHitAtK(
  retrieved: string[],
  relevant: string[],
  k: number
): number {
  if (relevant.length === 0) return 0;

  const relevantSet = new Set(relevant);
  const topK = retrieved.slice(0, k);

  for (const docId of topK) {
    if (relevantSet.has(docId)) {
      return 1;
    }
  }

  return 0;
}

/**
 * Calculate all metrics for a single query
 */
export function calculateQueryMetrics(
  retrieved: string[],
  relevant: string[],
  k: number = 10
): QueryMetrics {
  return {
    recall: calculateRecallAtK(retrieved, relevant, k),
    recallAt5: calculateRecallAtK(retrieved, relevant, 5),
    recallAt10: calculateRecallAtK(retrieved, relevant, 10),
    mrr: calculateMRR(retrieved, relevant),
    ndcg: calculateNDCGBinary(retrieved, relevant, k),
    precision: calculatePrecisionAtK(retrieved, relevant, k),
    hitAt1: calculateHitAtK(retrieved, relevant, 1),
    hitAt5: calculateHitAtK(retrieved, relevant, 5),
    hitAt10: calculateHitAtK(retrieved, relevant, 10),
  };
}

/**
 * Aggregate metrics across multiple queries
 */
export function aggregateMetrics(
  queryResults: Array<{
    metrics: QueryMetrics;
    latencyMs: number;
  }>
): PipelineMetrics {
  if (queryResults.length === 0) {
    return {
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      ndcg: 0,
      hitAt1: 0,
      hitAt5: 0,
      hitAt10: 0,
      avgLatencyMs: 0,
      queryCount: 0,
    };
  }

  const n = queryResults.length;

  // Calculate means for all metrics
  const sumRecallAt5 = queryResults.reduce((sum, r) => sum + (r.metrics.recallAt5 ?? 0), 0);
  const sumRecallAt10 = queryResults.reduce((sum, r) => sum + (r.metrics.recallAt10 ?? 0), 0);
  const sumMRR = queryResults.reduce((sum, r) => sum + (r.metrics.mrr ?? 0), 0);
  const sumNDCG = queryResults.reduce((sum, r) => sum + (r.metrics.ndcg ?? 0), 0);
  const sumHitAt1 = queryResults.reduce((sum, r) => sum + (r.metrics.hitAt1 ?? 0), 0);
  const sumHitAt5 = queryResults.reduce((sum, r) => sum + (r.metrics.hitAt5 ?? 0), 0);
  const sumHitAt10 = queryResults.reduce((sum, r) => sum + (r.metrics.hitAt10 ?? 0), 0);
  const sumLatency = queryResults.reduce((sum, r) => sum + r.latencyMs, 0);

  return {
    recallAt5: sumRecallAt5 / n,
    recallAt10: sumRecallAt10 / n,
    mrr: sumMRR / n,
    ndcg: sumNDCG / n,
    hitAt1: sumHitAt1 / n,
    hitAt5: sumHitAt5 / n,
    hitAt10: sumHitAt10 / n,
    avgLatencyMs: sumLatency / n,
    queryCount: n,
  };
}

/**
 * Measure latency of an async operation
 */
export async function measureLatency<T>(
  fn: () => Promise<T>
): Promise<{ result: T; latencyMs: number }> {
  const startTime = performance.now();
  const result = await fn();
  const latencyMs = performance.now() - startTime;

  return { result, latencyMs };
}

/**
 * Calculate statistical summary of latencies
 */
export function calculateLatencyStats(latencies: number[]): {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
} {
  if (latencies.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;

  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const p95Index = Math.ceil(0.95 * n) - 1;
  const p99Index = Math.ceil(0.99 * n) - 1;

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median,
    p95: sorted[Math.min(p95Index, n - 1)],
    p99: sorted[Math.min(p99Index, n - 1)],
  };
}

/**
 * Compare two sets of metrics
 */
export function compareMetrics(
  baseline: PipelineMetrics,
  comparison: PipelineMetrics
): {
  recallDiff: number;
  mrrDiff: number;
  ndcgDiff: number;
  latencyDiff: number;
  betterRecall: boolean;
  betterMRR: boolean;
  betterNDCG: boolean;
  fasterLatency: boolean;
} {
  return {
    recallDiff: comparison.recallAt10 - baseline.recallAt10,
    mrrDiff: comparison.mrr - baseline.mrr,
    ndcgDiff: comparison.ndcg - baseline.ndcg,
    latencyDiff: comparison.avgLatencyMs - baseline.avgLatencyMs,
    betterRecall: comparison.recallAt10 > baseline.recallAt10,
    betterMRR: comparison.mrr > baseline.mrr,
    betterNDCG: comparison.ndcg > baseline.ndcg,
    fasterLatency: comparison.avgLatencyMs < baseline.avgLatencyMs,
  };
}

/**
 * Calculate document coverage metrics
 * Measures how deeply each expected document is retrieved (multiple chunks per doc)
 */
export function calculateDocumentCoverage(
  results: SearchResult[],
  expectedDocumentIds: string[]
): DocumentCoverageMetrics {
  if (expectedDocumentIds.length === 0) {
    return { avgChunksPerExpectedDoc: 0, percentDocsWithMultipleChunks: 0 };
  }

  // Count chunks per document
  const chunkCountByDoc = new Map<string, number>();
  for (const result of results) {
    const count = chunkCountByDoc.get(result.documentId) || 0;
    chunkCountByDoc.set(result.documentId, count + 1);
  }

  // Filter to expected documents that were retrieved
  const expectedSet = new Set(expectedDocumentIds);
  const expectedRetrieved = [...chunkCountByDoc.entries()]
    .filter(([docId]) => expectedSet.has(docId));

  if (expectedRetrieved.length === 0) {
    return { avgChunksPerExpectedDoc: 0, percentDocsWithMultipleChunks: 0 };
  }

  const totalChunks = expectedRetrieved.reduce((sum, [, count]) => sum + count, 0);
  const avgChunksPerExpectedDoc = totalChunks / expectedRetrieved.length;

  const docsWithMultiple = expectedRetrieved.filter(([, count]) => count >= 2).length;
  const percentDocsWithMultipleChunks = docsWithMultiple / expectedDocumentIds.length;

  return { avgChunksPerExpectedDoc, percentDocsWithMultipleChunks };
}

/**
 * Calculate source diversity: unique_docs / topK
 * Higher values mean more diverse results from different documents
 */
export function calculateSourceDiversity(
  results: SearchResult[],
  topK: number
): number {
  if (results.length === 0 || topK === 0) return 0;
  const uniqueDocIds = new Set(results.map(r => r.documentId));
  return uniqueDocIds.size / Math.min(results.length, topK);
}

/**
 * Calculate compression ratio for LLM pipeline
 * Measures how much the summary compresses the original content
 */
export function calculateLLMCompressionRatio(
  results: SearchResult[]
): CompressionMetrics {
  const ratios: number[] = [];

  for (const result of results) {
    const metadata = result.metadata as { tokenCount?: number; summaryTokenCount?: number };
    if (metadata.tokenCount && metadata.summaryTokenCount && metadata.summaryTokenCount > 0) {
      ratios.push(metadata.tokenCount / metadata.summaryTokenCount);
    }
  }

  if (ratios.length === 0) {
    if (results.length > 0) {
      console.warn('LLM compression: No results had tokenCount/summaryTokenCount metadata. Defaulting to 1.0.');
    }
    return { avgCompressionRatio: 1, minCompressionRatio: 1, maxCompressionRatio: 1 };
  }

  return {
    avgCompressionRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    minCompressionRatio: Math.min(...ratios),
    maxCompressionRatio: Math.max(...ratios),
  };
}

/**
 * Calculate compression ratio for Facts pipeline
 * Measures how much the fact compresses the source context
 */
export function calculateFactCompressionRatio(
  results: SearchResult[]
): CompressionMetrics {
  const ratios: number[] = [];

  for (const result of results) {
    const metadata = result.metadata as { sourceContext?: string };
    if (metadata.sourceContext && result.content.length > 0) {
      ratios.push(metadata.sourceContext.length / result.content.length);
    }
  }

  if (ratios.length === 0) {
    if (results.length > 0) {
      console.warn('Fact compression: No results had sourceContext metadata. Defaulting to 1.0.');
    }
    return { avgCompressionRatio: 1, minCompressionRatio: 1, maxCompressionRatio: 1 };
  }

  return {
    avgCompressionRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    minCompressionRatio: Math.min(...ratios),
    maxCompressionRatio: Math.max(...ratios),
  };
}
