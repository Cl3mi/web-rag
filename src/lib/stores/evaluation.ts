/**
 * Svelte stores for evaluation state
 */

import { writable, derived } from 'svelte/store';
import type { PipelineMetrics, EvaluationRun } from '$lib/types';

// Store for evaluation runs
export const evaluationRuns = writable<EvaluationRun[]>([]);

// Store for current evaluation state
export const currentEvaluation = writable<{
  isRunning: boolean;
  progress: number;
  error: string | null;
}>({
  isRunning: false,
  progress: 0,
  error: null,
});

// Derived store for latest completed run
export const latestCompletedRun = derived(evaluationRuns, ($runs) => {
  const completed = $runs.filter((r) => r.status === 'completed');
  return completed.length > 0 ? completed[0] : null;
});

// Derived store for metrics comparison
export const metricsComparison = derived(latestCompletedRun, ($run) => {
  if (!$run) return null;

  const chunk = $run.metrics.chunk ?? $run.metrics.traditional;
  const fact = $run.metrics.fact ?? $run.metrics.facts;

  if (!chunk || !fact) return null;

  return {
    recallDiff: fact.recallAt10 - chunk.recallAt10,
    mrrDiff: fact.mrr - chunk.mrr,
    ndcgDiff: fact.ndcg - chunk.ndcg,
    latencyDiff: fact.avgLatencyMs - chunk.avgLatencyMs,
    winner: {
      recall: fact.recallAt10 > chunk.recallAt10 ? 'fact' : 'chunk',
      mrr: fact.mrr > chunk.mrr ? 'fact' : 'chunk',
      ndcg: fact.ndcg > chunk.ndcg ? 'fact' : 'chunk',
      latency: fact.avgLatencyMs < chunk.avgLatencyMs ? 'fact' : 'chunk',
    },
  };
});

// Actions
export function startEvaluation() {
  currentEvaluation.set({
    isRunning: true,
    progress: 0,
    error: null,
  });
}

export function updateProgress(progress: number) {
  currentEvaluation.update((state) => ({
    ...state,
    progress,
  }));
}

export function completeEvaluation(run: EvaluationRun) {
  evaluationRuns.update((runs) => [run, ...runs]);
  currentEvaluation.set({
    isRunning: false,
    progress: 100,
    error: null,
  });
}

export function failEvaluation(error: string) {
  currentEvaluation.set({
    isRunning: false,
    progress: 0,
    error,
  });
}

export function loadRuns(runs: EvaluationRun[]) {
  evaluationRuns.set(runs);
}
