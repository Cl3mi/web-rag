import {
  calculateRecallAtK,
  calculateMRR,
  calculateNDCGBinary,
  calculateHitAtK,
  calculateLatencyStats,
} from '$lib/server/evaluation/metrics';

export interface RetrievalMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
}

export interface LatencyBreakdown {
  retrievalMs: number;
  generationMs: number;
  totalMs: number;
}

export interface CollectorRow {
  queryId: string;
  query: string;
  answer: string;
  context: string;
  expectedUrls: string[];
  retrievedUrls: string[];
  retrieval: RetrievalMetrics;
  latency: LatencyBreakdown;
}

export function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

/** Compute retrieval metrics for one query. URLs normalised before matching. */
export function scoreRow(retrievedUrls: string[], expectedUrls: string[], k = 10): RetrievalMetrics {
  const retrieved = retrievedUrls.map(normalizeUrl);
  const expected = expectedUrls.map(normalizeUrl);
  return {
    recallAt5: calculateRecallAtK(retrieved, expected, 5),
    recallAt10: calculateRecallAtK(retrieved, expected, 10),
    mrr: calculateMRR(retrieved, expected),
    ndcg: calculateNDCGBinary(retrieved, expected, k),
    hitAt1: calculateHitAtK(retrieved, expected, 1),
    hitAt5: calculateHitAtK(retrieved, expected, 5),
    hitAt10: calculateHitAtK(retrieved, expected, 10),
  };
}

type LatencyStats = ReturnType<typeof calculateLatencyStats>;

export interface ReportSummary {
  total: number;
  retrieval: RetrievalMetrics;
  latency: { retrievalMs: LatencyStats; generationMs: LatencyStats; totalMs: LatencyStats };
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export function summarizeRows(rows: CollectorRow[]): ReportSummary {
  const keys: (keyof RetrievalMetrics)[] = [
    'recallAt5', 'recallAt10', 'mrr', 'ndcg', 'hitAt1', 'hitAt5', 'hitAt10',
  ];
  const retrieval = {} as RetrievalMetrics;
  for (const key of keys) retrieval[key] = mean(rows.map((r) => r.retrieval[key]));
  return {
    total: rows.length,
    retrieval,
    latency: {
      retrievalMs: calculateLatencyStats(rows.map((r) => r.latency.retrievalMs)),
      generationMs: calculateLatencyStats(rows.map((r) => r.latency.generationMs)),
      totalMs: calculateLatencyStats(rows.map((r) => r.latency.totalMs)),
    },
  };
}
