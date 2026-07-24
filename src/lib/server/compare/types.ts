import type { CollectorRow, ReportSummary } from '$lib/server/collector/scoring';

export interface EvalReport {
  systemLabel: string;
  sessionId: string;
  questionSetVersion: string;
  generatedAt: string;
  rows: CollectorRow[];
  summary: ReportSummary;
}

export interface JudgedRow {
  queryId: string;
  query: string;
  groundedness: number;
  completeness: number;
  correctness: number;
  hallucination: boolean;
  answerableFromContext: boolean;
  judgeMean: number;
  failureType: string | null;
  recallAt10: number;
  totalMs: number;
}

export interface SystemAggregate {
  systemLabel: string;
  total: number;
  judge: { groundedness: number | null; completeness: number | null; correctness: number | null; judgeMean: number | null };
  hallucinationRate: number;
  failureTypeCounts: Record<string, number>;
  answerableRate: number;
}

// Persisted comparison payload. Pure interface (no runtime imports) so the
// client `/compare` page can `import type` it without pulling server code.
export interface ComparisonPayload {
  reportA: { systemLabel: string; questionSetVersion: string; sessionId: string };
  reportB: { systemLabel: string; questionSetVersion: string; sessionId: string };
  versionMismatch: boolean;
  aggregates: { a: SystemAggregate; b: SystemAggregate };
  judgedRows: { a: JudgedRow[]; b: JudgedRow[] };
  latency: {
    a: { retrievalMs: number; generationMs: number; totalMs: number };
    b: { retrievalMs: number; generationMs: number; totalMs: number };
  };
}
