<script lang="ts">
  import { onMount } from 'svelte';

  interface FailureBreakdown {
    normal: number;
    generation_failure: number;
    retrieval_failure: number;
    robust_generation: number;
    unclassified: number;
  }

  interface QualityMetrics {
    meanGroundedness: number;
    meanCorrectness: number;
    meanCompleteness: number;
    hallucinationRate: number;
    judgeMean: number;
    totalJudged: number;
    failureBreakdown: FailureBreakdown;
  }

  interface RunSnapshot {
    runId: string;
    runName: string | null;
    startedAt: string;
    metrics: Record<string, QualityMetrics>;
  }

  interface QualityComparison {
    current: RunSnapshot | null;
    previous: RunSnapshot | null;
  }

  interface PreferenceStats {
    total: number;
    chosen: number;
    rejected: number;
    neutral: number;
    avgQualityScore: number;
    bySource: Record<string, number>;
  }

  interface PreferenceSample {
    id: string;
    question: string;
    answer: string;
    qualityScore: number | null;
    hallucination: boolean;
    chosen: boolean;
    rejected: boolean;
    source: string;
    pipelineName: string | null;
    failureType: string | null;
    createdAt: string;
  }

  interface JudgeDetailRow {
    id: string;
    question: string;
    pipelineName: string;
    generatedAnswer: string;
    groundedness: number;
    completeness: number;
    correctness: number;
    hallucination: boolean;
    failureType: string | null;
    recallAtK: number | null;
    judgeMean: number;
  }

  interface ModelEntry {
    id: string;
    baseModel: string;
    adapterPath: string | null;
    datasetSize: number;
    avgQualityScore: number | null;
    active: boolean;
    createdAt: string;
  }

  // State
  let qualityMetrics = $state<Record<string, QualityMetrics>>({});
  let comparison = $state<QualityComparison | null>(null);
  let preferenceStats = $state<PreferenceStats | null>(null);
  let preferenceSamples = $state<PreferenceSample[]>([]);
  let models = $state<ModelEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let prefFilter = $state<'all' | 'chosen' | 'rejected'>('all');

  // Failure detail drill-down
  let failureDetails = $state<JudgeDetailRow[]>([]);
  let failureDetailFilter = $state<string | null>(null);
  let failureDetailPipeline = $state<string | null>(null);
  let failureDetailLoading = $state(false);
  let expandedDetailId = $state<string | null>(null);

  // Judge configuration
  let judgeRuns = $state(3);

  // Operation states
  let judgeRunning = $state(false);
  let judgeResult = $state('');
  let prefRunning = $state(false);
  let prefResult = $state('');
  let exportRunning = $state(false);
  let exportResult = $state('');
  let trainRunning = $state(false);
  let trainResult = $state('');

  // Pipelines in order
  let pipelines = $derived(Object.keys(qualityMetrics).sort());

  // Best pipeline per metric (all 5 metrics)
  let bestPipeline = $derived.by(() => {
    if (pipelines.length === 0) return { groundedness: '', correctness: '', completeness: '', hallucination: '', judgeMean: '' };
    const best = (metric: keyof QualityMetrics, higher: boolean = true) => {
      let bestName = '';
      let bestVal = higher ? -1 : Infinity;
      for (const p of pipelines) {
        const val = qualityMetrics[p][metric] as number;
        if ((higher && val > bestVal) || (!higher && val < bestVal)) {
          bestVal = val;
          bestName = p;
        }
      }
      return bestName;
    };
    return {
      groundedness: best('meanGroundedness'),
      correctness: best('meanCorrectness'),
      completeness: best('meanCompleteness'),
      hallucination: best('hallucinationRate', false),
      judgeMean: best('judgeMean'),
    };
  });

  // For failure breakdown: prefer current-run data so the table reflects the latest
  // evaluation instead of accumulating all-time counts that barely shift.
  // Falls back to all-time qualityMetrics when no comparison data exists.
  let failureMetrics = $derived<Record<string, QualityMetrics>>(
    comparison?.current?.metrics ?? qualityMetrics
  );
  let failurePipelines = $derived(Object.keys(failureMetrics).sort());

  let deltaMetrics = $derived.by(() => {
    if (!comparison?.current || !comparison?.previous) return null;
    const result: Record<string, Record<string, number>> = {};
    for (const pipeline of Object.keys(comparison.current.metrics)) {
      const cur = comparison.current.metrics[pipeline];
      const prev = comparison.previous.metrics[pipeline];
      if (!prev) continue;
      result[pipeline] = {
        meanGroundedness:    cur.meanGroundedness  - prev.meanGroundedness,
        meanCorrectness:     cur.meanCorrectness   - prev.meanCorrectness,
        meanCompleteness:    cur.meanCompleteness  - prev.meanCompleteness,
        hallucinationRate:   cur.hallucinationRate - prev.hallucinationRate,
        judgeMean:           cur.judgeMean         - prev.judgeMean,
        normal:              cur.failureBreakdown.normal              - prev.failureBreakdown.normal,
        generation_failure:  cur.failureBreakdown.generation_failure  - prev.failureBreakdown.generation_failure,
        retrieval_failure:   cur.failureBreakdown.retrieval_failure   - prev.failureBreakdown.retrieval_failure,
        robust_generation:   cur.failureBreakdown.robust_generation   - prev.failureBreakdown.robust_generation,
      };
    }
    return result;
  });

  async function loadData() {
    loading = true;
    error = '';

    try {
      const [metricsRes, prefRes, modelsRes] = await Promise.all([
        fetch('/api/judge'),
        fetch(`/api/preferences?filter=${prefFilter}`),
        fetch('/api/models'),
      ]);

      if (metricsRes.ok) {
        const data = await metricsRes.json();
        qualityMetrics = data.metrics || {};
        comparison = data.comparison ?? null;
      }

      if (prefRes.ok) {
        const data = await prefRes.json();
        preferenceStats = data.stats || null;
        preferenceSamples = data.samples || [];
      }

      if (modelsRes.ok) {
        const data = await modelsRes.json();
        models = data.models || [];
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data';
    } finally {
      loading = false;
    }
  }

  async function loadPreferenceSamples() {
    try {
      const res = await fetch(`/api/preferences?filter=${prefFilter}`);
      if (res.ok) {
        const data = await res.json();
        preferenceStats = data.stats || null;
        preferenceSamples = data.samples || [];
      }
    } catch (e) {
      console.error('Load preference samples error:', e);
    }
  }

  let failureDetailError = $state('');

  async function loadFailureDetails(failureType?: string, pipeline?: string) {
    failureDetailLoading = true;
    failureDetailFilter = failureType ?? null;
    failureDetailPipeline = pipeline ?? null;
    failureDetailError = '';
    expandedDetailId = null;
    try {
      const params = new URLSearchParams({ details: '1' });
      if (failureType) params.set('failureType', failureType);
      if (pipeline) params.set('pipeline', pipeline);
      // Scope to the same run the table is showing (current run if available)
      if (comparison?.current?.runId) params.set('runId', comparison.current.runId);
      console.log('[detail fetch]', `/api/judge?${params}`);
      const res = await fetch(`/api/judge?${params}`);
      const data = await res.json();
      if (res.ok) {
        failureDetails = data.details || [];
        console.log('[detail fetch] rows returned:', failureDetails.length);
      } else {
        failureDetailError = data.error ?? `HTTP ${res.status}`;
        console.error('[detail fetch] API error:', failureDetailError);
        failureDetails = [];
      }
    } catch (e) {
      failureDetailError = e instanceof Error ? e.message : 'Network error';
      console.error('Load failure details error:', e);
    } finally {
      failureDetailLoading = false;
    }
  }

  function clearFailureDetails() {
    failureDetails = [];
    failureDetailFilter = null;
    failureDetailPipeline = null;
    expandedDetailId = null;
  }

  function failureTypeLabel(ft: string | null): string {
    switch (ft) {
      case 'normal': return 'Normal';
      case 'generation_failure': return 'Gen Failure';
      case 'retrieval_failure': return 'Ret Failure';
      case 'robust_generation': return 'Robust Gen';
      default: return 'Unclassified';
    }
  }

  function failureTypeCssClass(ft: string | null): string {
    switch (ft) {
      case 'normal': return 'ft-normal';
      case 'generation_failure': return 'ft-gen-fail';
      case 'retrieval_failure': return 'ft-ret-fail';
      case 'robust_generation': return 'ft-robust';
      default: return 'ft-unclassified';
    }
  }

  function pipelineCssClass(p: string | null): string {
    return p ? `pipeline-${p}` : '';
  }

  async function runJudge() {
    judgeRunning = true;
    judgeResult = '';
    try {
      const res = await fetch('/api/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchSize: 20, judgeRuns }),
      });
      const data = await res.json();
      if (res.ok) {
        judgeResult = `Judged: ${data.judged}, Failed: ${data.failed}, Total: ${data.total}`;
        await loadData();
      } else {
        judgeResult = `Error: ${data.error}`;
      }
    } catch (e) {
      judgeResult = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      judgeRunning = false;
    }
  }

  async function populatePreferences() {
    prefRunning = true;
    prefResult = '';
    try {
      const res = await fetch('/api/preferences', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        prefResult = `Inserted: ${data.inserted}, Chosen: ${data.chosen}, Rejected: ${data.rejected}${data.relabeled ? `, Re-labeled: ${data.relabeled}` : ''}`;
        await loadData();
      } else {
        prefResult = `Error: ${data.error}`;
      }
    } catch (e) {
      prefResult = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      prefRunning = false;
    }
  }

  async function exportData() {
    exportRunning = true;
    exportResult = '';
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        exportResult = `Exported ${data.rowCount} rows to ${data.path}`;
      } else {
        exportResult = `Error: ${data.error}`;
      }
    } catch (e) {
      exportResult = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      exportRunning = false;
    }
  }

  async function trainModel() {
    trainRunning = true;
    trainResult = '';
    try {
      const res = await fetch('/api/training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        trainResult = `Model ${data.modelId} registered. Dataset: ${data.datasetSize} rows. Config: ${data.configPath}`;
        await loadData();
      } else {
        trainResult = `Error: ${data.error}`;
      }
    } catch (e) {
      trainResult = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      trainRunning = false;
    }
  }

  async function setActiveModel(modelId: string) {
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      if (res.ok) {
        await loadData();
      }
    } catch (e) {
      console.error('Activate model error:', e);
    }
  }

  function formatScore(n: number | undefined): string {
    if (n === undefined || isNaN(n)) return '-';
    return n.toFixed(2);
  }

  function formatPercent(n: number | undefined): string {
    if (n === undefined || isNaN(n)) return '0%';
    return (n * 100).toFixed(1) + '%';
  }

  function scoreColor(score: number, max: number = 5): string {
    const ratio = score / max;
    if (ratio >= 0.8) return 'score-high';
    if (ratio >= 0.5) return 'score-medium';
    return 'score-low';
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
  }

  function pctOf(count: number, total: number): string {
    if (total === 0) return '0';
    return ((count / total) * 100).toFixed(0);
  }

  onMount(() => {
    loadData();
  });
</script>

<svelte:head>
  <title>Answer Quality - RAG Lab</title>
</svelte:head>

<div class="quality-page">
  <header class="page-header">
    <h1>Answer Quality</h1>
    <p class="subtitle">Generation evaluation, judging, and preference optimization</p>
  </header>

  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Loading quality data...</span>
    </div>
  {:else}

    <!-- Pipeline Quality Comparison -->
    {#if pipelines.length > 0}
      <section class="card">
        <h2>Pipeline Quality Comparison</h2>
        <p class="section-desc">Aggregated answer quality metrics from LLM judge evaluations. Scores are 1-5 (higher = better).</p>
        {#if comparison?.previous}
          <p class="run-comparison-hint">
            vs <strong>{comparison.previous.runName ?? 'Run'}</strong>
            ({new Date(comparison.previous.startedAt).toLocaleDateString()})
            → <strong>{comparison.current?.runName ?? 'Run'}</strong>
            ({new Date(comparison.current!.startedAt).toLocaleDateString()})
          </p>
        {/if}

        <div class="quality-grid" style="grid-template-columns: repeat({pipelines.length}, 1fr)">
          {#each pipelines as pipeline}
            {@const m = qualityMetrics[pipeline]}
            <div class="quality-card pipeline-{pipeline}">
              <h3 class="pipeline-label">{pipeline.charAt(0).toUpperCase() + pipeline.slice(1)} Pipeline</h3>
              <div class="judged-count">{m.totalJudged} answers judged</div>

              <div class="scores-grid">
                <div class="score-item">
                  <div class="score-value {scoreColor(m.meanGroundedness)}">{formatScore(m.meanGroundedness)}</div>
                  <div class="score-label">Groundedness</div>
                  {#if bestPipeline.groundedness === pipeline}
                    <span class="best-badge">Best</span>
                  {/if}
                  {#if (deltaMetrics?.[pipeline]?.['meanGroundedness'] ?? 0) !== 0}
                    {@const dg = deltaMetrics?.[pipeline]?.['meanGroundedness'] ?? 0}
                    <div class="score-delta" class:delta-up={dg > 0} class:delta-down={dg < 0}>
                      {dg > 0 ? '▲' : '▼'} {Math.abs(dg).toFixed(2)}
                    </div>
                  {/if}
                </div>
                <div class="score-item">
                  <div class="score-value {scoreColor(m.meanCorrectness)}">{formatScore(m.meanCorrectness)}</div>
                  <div class="score-label">Correctness</div>
                  {#if bestPipeline.correctness === pipeline}
                    <span class="best-badge">Best</span>
                  {/if}
                  {#if (deltaMetrics?.[pipeline]?.['meanCorrectness'] ?? 0) !== 0}
                    {@const dc = deltaMetrics?.[pipeline]?.['meanCorrectness'] ?? 0}
                    <div class="score-delta" class:delta-up={dc > 0} class:delta-down={dc < 0}>
                      {dc > 0 ? '▲' : '▼'} {Math.abs(dc).toFixed(2)}
                    </div>
                  {/if}
                </div>
                <div class="score-item">
                  <div class="score-value {scoreColor(m.meanCompleteness)}">{formatScore(m.meanCompleteness)}</div>
                  <div class="score-label">Completeness</div>
                  {#if bestPipeline.completeness === pipeline}
                    <span class="best-badge">Best</span>
                  {/if}
                  {#if (deltaMetrics?.[pipeline]?.['meanCompleteness'] ?? 0) !== 0}
                    {@const dcm = deltaMetrics?.[pipeline]?.['meanCompleteness'] ?? 0}
                    <div class="score-delta" class:delta-up={dcm > 0} class:delta-down={dcm < 0}>
                      {dcm > 0 ? '▲' : '▼'} {Math.abs(dcm).toFixed(2)}
                    </div>
                  {/if}
                </div>
                <div class="score-item">
                  <div class="score-value {scoreColor(1 - m.hallucinationRate, 1)}">{formatPercent(m.hallucinationRate)}</div>
                  <div class="score-label">Hallucination Rate</div>
                  {#if bestPipeline.hallucination === pipeline}
                    <span class="best-badge">Lowest</span>
                  {/if}
                  {#if (deltaMetrics?.[pipeline]?.['hallucinationRate'] ?? 0) !== 0}
                    {@const dh = deltaMetrics?.[pipeline]?.['hallucinationRate'] ?? 0}
                    <div class="score-delta" class:delta-up={dh < 0} class:delta-down={dh > 0}>
                      {dh > 0 ? '▲' : '▼'} {Math.abs(dh * 100).toFixed(1)}%
                    </div>
                  {/if}
                </div>
                <div class="score-item">
                  <div class="score-value {scoreColor(m.judgeMean)}">{formatScore(m.judgeMean)}</div>
                  <div class="score-label">Judge Mean</div>
                  {#if bestPipeline.judgeMean === pipeline}
                    <span class="best-badge">Best</span>
                  {/if}
                  {#if (deltaMetrics?.[pipeline]?.['judgeMean'] ?? 0) !== 0}
                    {@const djm = deltaMetrics?.[pipeline]?.['judgeMean'] ?? 0}
                    <div class="score-delta" class:delta-up={djm > 0} class:delta-down={djm < 0}>
                      {djm > 0 ? '▲' : '▼'} {Math.abs(djm).toFixed(2)}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      </section>

      <!-- Failure Diagnosis -->
      <section class="card">
        <h2>Where Does the Pipeline Fail?</h2>
        <p class="section-desc">
          Compares retrieval quality (Recall) with answer quality (Judge Mean) to diagnose the root cause of bad answers.
          {#if comparison?.current}
            Showing <strong>latest run</strong>
            ({comparison.current.runName ?? 'Run'}, {new Date(comparison.current.startedAt).toLocaleDateString()}).
          {:else}
            Showing <strong>all-time aggregate</strong> across all runs.
          {/if}
        </p>

        <div class="diagnosis-legend">
          <div class="legend-item">
            <span class="legend-dot normal"></span>
            <div>
              <strong>Normal</strong>
              <span class="legend-desc">Good retrieval + Good answer. Everything works.</span>
            </div>
          </div>
          <div class="legend-item">
            <span class="legend-dot gen-fail"></span>
            <div>
              <strong>Generation Failure</strong>
              <span class="legend-desc">Retrieved the right documents but generated a bad answer. Fix the generation model.</span>
            </div>
          </div>
          <div class="legend-item">
            <span class="legend-dot ret-fail"></span>
            <div>
              <strong>Retrieval Failure</strong>
              <span class="legend-desc">Retrieved wrong documents and generated a bad answer. Fix retrieval/embeddings.</span>
            </div>
          </div>
          <div class="legend-item">
            <span class="legend-dot robust"></span>
            <div>
              <strong>Robust Generation</strong>
              <span class="legend-desc">Retrieved wrong documents but still generated a decent answer. Model compensated.</span>
            </div>
          </div>
        </div>

        <div class="failure-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Normal</th>
                <th>Generation Failure</th>
                <th>Retrieval Failure</th>
                <th>Robust Generation</th>
                {#if failurePipelines.some(p => failureMetrics[p].failureBreakdown.unclassified > 0)}
                  <th>Unclassified</th>
                {/if}
              </tr>
            </thead>
            <tbody>
              {#each failurePipelines as pipeline}
                {@const fb = failureMetrics[pipeline].failureBreakdown}
                {@const total = failureMetrics[pipeline].totalJudged}
                <tr>
                  <td class="pipeline-cell pipeline-{pipeline}">{pipeline}</td>
                  <td class="failure-cell">
                    <button class="failure-link normal-count" onclick={() => loadFailureDetails('normal', pipeline)} disabled={fb.normal === 0}>
                      {fb.normal} <span class="failure-pct">({pctOf(fb.normal, total)}%)</span>
                    </button>
                    {#if (deltaMetrics?.[pipeline]?.['normal'] ?? 0) !== 0}
                      {@const fn = deltaMetrics?.[pipeline]?.['normal'] ?? 0}
                      <span class="ft-delta" class:delta-up={fn < 0} class:delta-down={fn > 0}>{fn > 0 ? '+' : ''}{fn}</span>
                    {/if}
                  </td>
                  <td class="failure-cell">
                    <button class="failure-link gen-fail" onclick={() => loadFailureDetails('generation_failure', pipeline)} disabled={fb.generation_failure === 0}>
                      {fb.generation_failure} <span class="failure-pct">({pctOf(fb.generation_failure, total)}%)</span>
                    </button>
                    {#if (deltaMetrics?.[pipeline]?.['generation_failure'] ?? 0) !== 0}
                      {@const fgf = deltaMetrics?.[pipeline]?.['generation_failure'] ?? 0}
                      <span class="ft-delta" class:delta-up={fgf < 0} class:delta-down={fgf > 0}>{fgf > 0 ? '+' : ''}{fgf}</span>
                    {/if}
                  </td>
                  <td class="failure-cell">
                    <button class="failure-link ret-fail" onclick={() => loadFailureDetails('retrieval_failure', pipeline)} disabled={fb.retrieval_failure === 0}>
                      {fb.retrieval_failure} <span class="failure-pct">({pctOf(fb.retrieval_failure, total)}%)</span>
                    </button>
                    {#if (deltaMetrics?.[pipeline]?.['retrieval_failure'] ?? 0) !== 0}
                      {@const frf = deltaMetrics?.[pipeline]?.['retrieval_failure'] ?? 0}
                      <span class="ft-delta" class:delta-up={frf < 0} class:delta-down={frf > 0}>{frf > 0 ? '+' : ''}{frf}</span>
                    {/if}
                  </td>
                  <td class="failure-cell">
                    <button class="failure-link robust" onclick={() => loadFailureDetails('robust_generation', pipeline)} disabled={fb.robust_generation === 0}>
                      {fb.robust_generation} <span class="failure-pct">({pctOf(fb.robust_generation, total)}%)</span>
                    </button>
                    {#if (deltaMetrics?.[pipeline]?.['robust_generation'] ?? 0) !== 0}
                      {@const frg = deltaMetrics?.[pipeline]?.['robust_generation'] ?? 0}
                      <span class="ft-delta" class:delta-up={frg < 0} class:delta-down={frg > 0}>{frg > 0 ? '+' : ''}{frg}</span>
                    {/if}
                  </td>
                  {#if failurePipelines.some(p => failureMetrics[p].failureBreakdown.unclassified > 0)}
                    <td class="failure-cell">
                      <button class="failure-link" onclick={() => loadFailureDetails('unclassified', pipeline)} disabled={fb.unclassified === 0}>
                        {fb.unclassified} <span class="failure-pct">({pctOf(fb.unclassified, total)}%)</span>
                      </button>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- Visual bar breakdown -->
        {#each failurePipelines as pipeline}
          {@const fb = failureMetrics[pipeline].failureBreakdown}
          {@const total = failureMetrics[pipeline].totalJudged}
          {#if total > 0}
            <div class="diagnosis-bar-row">
              <span class="bar-label pipeline-{pipeline}">{pipeline}</span>
              <div class="diagnosis-bar">
                {#if fb.normal > 0}
                  <button class="bar-segment normal" style="width: {(fb.normal / total) * 100}%" title="Normal: {fb.normal}" onclick={() => loadFailureDetails('normal', pipeline)}></button>
                {/if}
                {#if fb.generation_failure > 0}
                  <button class="bar-segment gen-fail" style="width: {(fb.generation_failure / total) * 100}%" title="Generation Failure: {fb.generation_failure}" onclick={() => loadFailureDetails('generation_failure', pipeline)}></button>
                {/if}
                {#if fb.retrieval_failure > 0}
                  <button class="bar-segment ret-fail" style="width: {(fb.retrieval_failure / total) * 100}%" title="Retrieval Failure: {fb.retrieval_failure}" onclick={() => loadFailureDetails('retrieval_failure', pipeline)}></button>
                {/if}
                {#if fb.robust_generation > 0}
                  <button class="bar-segment robust" style="width: {(fb.robust_generation / total) * 100}%" title="Robust Generation: {fb.robust_generation}" onclick={() => loadFailureDetails('robust_generation', pipeline)}></button>
                {/if}
                {#if fb.unclassified > 0}
                  <button class="bar-segment unclassified" style="width: {(fb.unclassified / total) * 100}%" title="Unclassified: {fb.unclassified}" onclick={() => loadFailureDetails('unclassified', pipeline)}></button>
                {/if}
              </div>
            </div>
          {/if}
        {/each}

        <!-- Failure Detail Drill-Down -->
        {#if failureDetailFilter !== null || failureDetails.length > 0}
          <div class="detail-panel">
            <div class="detail-header">
              <h3>
                {#if failureDetailPipeline}
                  <span class="pipeline-{failureDetailPipeline}" style="text-transform: capitalize">{failureDetailPipeline}</span> &mdash;
                {/if}
                <span class="{failureTypeCssClass(failureDetailFilter)}">{failureTypeLabel(failureDetailFilter)}</span>
                ({failureDetails.length} rows
                {#if comparison?.current?.runId}
                  &middot; {comparison.current.runName ?? 'latest run'}
                {:else}
                  &middot; all runs
                {/if})
              </h3>
              <button class="btn btn-outline btn-sm" onclick={clearFailureDetails}>Close</button>
            </div>

            {#if failureDetailLoading}
              <div class="loading-state" style="padding: 20px"><div class="spinner"></div> Loading...</div>
            {:else if failureDetailError}
              <p class="empty-hint" style="color:#e74c3c">API error: {failureDetailError}</p>
            {:else if failureDetails.length === 0}
              <p class="empty-hint">No rows found for this filter.</p>
            {:else}
              <div class="detail-list">
                {#each failureDetails as row}
                  <div class="detail-row" class:expanded={expandedDetailId === row.id}>
                    <button class="detail-row-header" onclick={() => expandedDetailId = expandedDetailId === row.id ? null : row.id}>
                      <span class="detail-pipeline pipeline-{row.pipelineName}">{row.pipelineName}</span>
                      <span class="detail-question">{row.question}</span>
                      <span class="detail-scores">
                        G:{row.groundedness} C:{row.correctness} Cm:{row.completeness}
                        {#if row.hallucination}<span class="halluc-tag">H</span>{/if}
                      </span>
                      <span class="detail-recall">R@k: {row.recallAtK !== null ? row.recallAtK.toFixed(2) : '-'}</span>
                      <span class="detail-expand">{expandedDetailId === row.id ? '\u25B2' : '\u25BC'}</span>
                    </button>
                    {#if expandedDetailId === row.id}
                      <div class="detail-answer">
                        <div class="detail-answer-label">Generated Answer:</div>
                        <div class="detail-answer-text">{row.generatedAnswer}</div>
                        <div class="detail-meta">
                          Judge Mean: {row.judgeMean.toFixed(2)} |
                          Groundedness: {row.groundedness}/5 |
                          Correctness: {row.correctness}/5 |
                          Completeness: {row.completeness}/5 |
                          Recall@k: {row.recallAtK !== null ? row.recallAtK.toFixed(2) : 'N/A'}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </section>
    {:else}
      <section class="card empty-state">
        <h2>No Quality Data Yet</h2>
        <p>Run an evaluation with answer generation enabled, then use the judge below to evaluate answers.</p>
      </section>
    {/if}

    <!-- Preference Dataset -->
    {#if preferenceStats && preferenceStats.total > 0}
      <section class="card">
        <h2>Preference Dataset</h2>
        <p class="section-desc">
          Built from judge results. <strong>Chosen</strong> = judge mean ≥ 3.5, no hallucination (training positive examples).
          <strong>Rejected</strong> = judge mean &lt; 2.5 or hallucination (training negative examples).
          Judge mean averages groundedness, completeness, and correctness — refusal/no-answer messages that score well on groundedness alone are excluded.
          Used to create JSONL training data for LoRA fine-tuning.
        </p>

        <div class="stats-row">
          <div class="stat-item">
            <div class="stat-value">{preferenceStats.total}</div>
            <div class="stat-label">Total Entries</div>
          </div>
          <div class="stat-item">
            <div class="stat-value score-high">{preferenceStats.chosen}</div>
            <div class="stat-label">Chosen (for training)</div>
          </div>
          <div class="stat-item">
            <div class="stat-value score-low">{preferenceStats.rejected}</div>
            <div class="stat-label">Rejected</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">{preferenceStats.neutral}</div>
            <div class="stat-label">Neutral</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">{formatScore(preferenceStats.avgQualityScore)}</div>
            <div class="stat-label">Avg Quality (1-5)</div>
          </div>
        </div>

        <!-- Filter tabs and sample table -->
        <div class="pref-samples-section">
          <div class="pref-filter-row">
            <h3>Dataset Samples</h3>
            <div class="filter-tabs">
              {#each ['all', 'chosen', 'rejected'] as f}
                <button
                  class="filter-tab"
                  class:active={prefFilter === f}
                  onclick={() => { prefFilter = f as 'all' | 'chosen' | 'rejected'; loadPreferenceSamples(); }}
                >{f.charAt(0).toUpperCase() + f.slice(1)}</button>
              {/each}
            </div>
          </div>

          {#if preferenceSamples.length > 0}
            <div class="samples-table-wrapper">
              <table class="data-table samples-table">
                <thead>
                  <tr>
                    <th>Pipeline</th>
                    <th class="col-question">Question</th>
                    <th>Answer (preview)</th>
                    <th>Quality</th>
                    <th>Label</th>
                    <th>Failure Type</th>
                  </tr>
                </thead>
                <tbody>
                  {#each preferenceSamples as sample}
                    <tr>
                      <td>
                        {#if sample.pipelineName}
                          <span class="pipeline-badge {pipelineCssClass(sample.pipelineName)}">{sample.pipelineName}</span>
                        {:else}
                          <span class="pipeline-badge">-</span>
                        {/if}
                      </td>
                      <td class="sample-question" title={sample.question}>
                        {sample.question.length > 60 ? sample.question.slice(0, 60) + '...' : sample.question}
                      </td>
                      <td class="sample-answer" title={sample.answer}>
                        {sample.answer.length > 80 ? sample.answer.slice(0, 80) + '...' : sample.answer}
                      </td>
                      <td class="sample-quality">
                        <span class="{scoreColor(sample.qualityScore ?? 0)}">{sample.qualityScore !== null ? sample.qualityScore.toFixed(1) : '-'}</span>
                        {#if sample.hallucination}
                          <span class="halluc-tag">H</span>
                        {/if}
                      </td>
                      <td>
                        {#if sample.chosen}
                          <span class="label-badge chosen">Chosen</span>
                        {:else if sample.rejected}
                          <span class="label-badge rejected">Rejected</span>
                        {:else}
                          <span class="label-badge neutral">Neutral</span>
                        {/if}
                      </td>
                      <td>
                        {#if sample.failureType}
                          <span class="ft-badge {failureTypeCssClass(sample.failureType)}">{failureTypeLabel(sample.failureType)}</span>
                        {:else}
                          <span class="ft-badge ft-unclassified">-</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <p class="empty-hint">No samples match this filter.</p>
          {/if}
        </div>
      </section>
    {:else if preferenceStats}
      <section class="card">
        <h2>Preference Dataset</h2>
        <p class="empty-hint">No preference data yet. Run judge, then populate preferences using the controls below.</p>
      </section>
    {/if}

    <!-- Model Registry -->
    <section class="card">
      <h2>Model Registry</h2>
      {#if models.length > 0}
        <div class="models-list">
          {#each models as model}
            <div class="model-item" class:active={model.active}>
              <div class="model-info">
                <div class="model-name">
                  {model.baseModel}
                  {#if model.active}
                    <span class="badge badge-green">Active</span>
                  {/if}
                </div>
                <div class="model-meta">
                  {model.datasetSize} training samples |
                  Quality: {model.avgQualityScore !== null ? formatScore(model.avgQualityScore) : 'N/A'} |
                  {formatDate(model.createdAt)}
                </div>
                {#if model.adapterPath}
                  <div class="model-path">{model.adapterPath}</div>
                {/if}
              </div>
              {#if !model.active}
                <button class="btn btn-outline btn-sm" onclick={() => setActiveModel(model.id)}>
                  Activate
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty-hint">No models registered yet. Train a model using the controls below.</p>
      {/if}
    </section>

    <!-- Manual Control Panel -->
    <section class="card control-panel">
      <h2>Manual Controls</h2>
      <p class="section-desc">All operations are manually triggered. Run them in order: Judge -> Preferences -> Export -> Train.</p>

      <div class="controls-grid">
        <div class="control-item">
          <div class="control-header">
            <h3>1. Run Judge</h3>
            <p class="control-desc">Evaluate unjudged answers using LLM-as-judge. Each answer is judged multiple times and scores are averaged for reliability.</p>
          </div>
          <div class="judge-runs-row">
            <label class="runs-label" for="judge-runs">Runs per answer</label>
            <input
              id="judge-runs"
              type="number"
              min="1"
              max="10"
              bind:value={judgeRuns}
              class="runs-input"
            />
            <span class="runs-hint">(mean of {judgeRuns} {judgeRuns === 1 ? 'run' : 'runs'})</span>
          </div>
          <button class="btn btn-primary" onclick={runJudge} disabled={judgeRunning}>
            {#if judgeRunning}
              <span class="spinner-small"></span> Judging...
            {:else}
              Run Judge
            {/if}
          </button>
          {#if judgeResult}
            <p class="control-result">{judgeResult}</p>
          {/if}
        </div>

        <div class="control-item">
          <div class="control-header">
            <h3>2. Populate Preferences</h3>
            <p class="control-desc">Label judged data as chosen/rejected for training.</p>
          </div>
          <button class="btn btn-primary" onclick={populatePreferences} disabled={prefRunning}>
            {#if prefRunning}
              <span class="spinner-small"></span> Populating...
            {:else}
              Populate Preferences
            {/if}
          </button>
          {#if prefResult}
            <p class="control-result">{prefResult}</p>
          {/if}
        </div>

        <div class="control-item">
          <div class="control-header">
            <h3>3. Export Training Data</h3>
            <p class="control-desc">Export chosen preferences as JSONL for fine-tuning.</p>
          </div>
          <button class="btn btn-primary" onclick={exportData} disabled={exportRunning}>
            {#if exportRunning}
              <span class="spinner-small"></span> Exporting...
            {:else}
              Export JSONL
            {/if}
          </button>
          {#if exportResult}
            <p class="control-result">{exportResult}</p>
          {/if}
        </div>

        <div class="control-item">
          <div class="control-header">
            <h3>4. Prepare LoRA Training</h3>
            <p class="control-desc">Export dataset, generate config, register model.</p>
          </div>
          <button class="btn btn-primary" onclick={trainModel} disabled={trainRunning}>
            {#if trainRunning}
              <span class="spinner-small"></span> Preparing...
            {:else}
              Prepare Training
            {/if}
          </button>
          {#if trainResult}
            <p class="control-result">{trainResult}</p>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  .quality-page {
    padding: 24px;
    max-width: 90vw;
  }

  .page-header {
    margin-bottom: 24px;
  }

  .page-header h1 {
    font-size: 1.75rem;
    color: #fff;
    margin-bottom: 4px;
  }

  .subtitle {
    color: #888;
    font-size: 0.9rem;
  }

  .section-desc {
    color: #888;
    font-size: 0.85rem;
    margin-bottom: 16px;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 60px;
    gap: 16px;
    color: #888;
  }

  .card {
    background: #2d2d2d;
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 24px;
  }

  .card h2 {
    font-size: 1.1rem;
    color: #fff;
    margin-bottom: 12px;
  }

  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: #888;
  }

  .empty-hint {
    color: #888;
    font-size: 0.85rem;
  }

  /* Quality Grid */
  .quality-grid {
    display: grid;
    gap: 16px;
    overflow-x: auto;
    padding: 0 0 8px 0;
  }

  .quality-card {
    background: #373737;
    border-radius: 8px;
    padding: 16px;
    border-top: 3px solid #444;
  }

  .quality-card.pipeline-chunk { border-top-color: #4da3ff; }
  .quality-card.pipeline-fact { border-top-color: #28a745; }
  .quality-card.pipeline-llm { border-top-color: #9b59b6; }

  .pipeline-label {
    font-size: 0.95rem;
    color: #ccc;
    margin-bottom: 4px;
  }

  .judged-count {
    font-size: 0.75rem;
    color: #888;
    margin-bottom: 12px;
  }

  .scores-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
  }

  @media (max-width: 900px) {
    .scores-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  .score-item {
    text-align: center;
    position: relative;
  }

  .score-value {
    font-size: 1.2rem;
    font-weight: 600;
    color: #fff;
    margin-bottom: 2px;
  }

  .score-value.score-high { color: #28a745; }
  .score-value.score-medium { color: #ffc107; }
  .score-value.score-low { color: #dc3545; }

  .score-label {
    font-size: 0.7rem;
    color: #888;
  }

  .best-badge {
    display: inline-block;
    font-size: 0.6rem;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(40, 167, 69, 0.2);
    color: #28a745;
    margin-top: 2px;
  }

  /* Diagnosis Legend */
  .diagnosis-legend {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-bottom: 20px;
    padding: 14px;
    background: #333;
    border-radius: 6px;
  }

  @media (max-width: 768px) {
    .diagnosis-legend {
      grid-template-columns: 1fr;
    }
  }

  .legend-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 0.82rem;
  }

  .legend-dot {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    flex-shrink: 0;
    margin-top: 3px;
  }

  .legend-dot.normal { background: #2ecc71; }
  .legend-dot.gen-fail { background: #e74c3c; }
  .legend-dot.ret-fail { background: #f39c12; }
  .legend-dot.robust { background: #3498db; }

  .legend-item strong {
    color: #ddd;
    display: block;
    margin-bottom: 1px;
  }

  .legend-desc {
    color: #999;
    font-size: 0.78rem;
  }

  /* Failure Analysis Table */
  .failure-table-wrapper {
    overflow-x: auto;
    margin-bottom: 16px;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .data-table th,
  .data-table td {
    padding: 10px 14px;
    text-align: center;
    border-bottom: 1px solid #3a3a3a;
  }

  .data-table th {
    color: #888;
    font-weight: 500;
    font-size: 0.8rem;
  }

  .data-table th:first-child,
  .data-table td:first-child {
    text-align: left;
  }

  .pipeline-cell {
    font-weight: 500;
    text-transform: capitalize;
  }

  .pipeline-cell.pipeline-chunk { color: #4da3ff; }
  .pipeline-cell.pipeline-fact { color: #28a745; }
  .pipeline-cell.pipeline-llm { color: #9b59b6; }

  .failure-cell {
    white-space: nowrap;
  }

  .failure-count {
    font-weight: 600;
    color: #fff;
  }

  .failure-count.normal-count { color: #2ecc71; }
  .failure-count.gen-fail { color: #e74c3c; }
  .failure-count.ret-fail { color: #f39c12; }
  .failure-count.robust { color: #3498db; }

  .failure-pct {
    font-size: 0.75rem;
    color: #888;
    margin-left: 4px;
  }

  /* Diagnosis Stacked Bar */
  .diagnosis-bar-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }

  .bar-label {
    width: 50px;
    font-size: 0.8rem;
    font-weight: 500;
    text-transform: capitalize;
    flex-shrink: 0;
  }

  .diagnosis-bar {
    flex: 1;
    height: 22px;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    background: #444;
  }

  .bar-segment {
    height: 100%;
    min-width: 2px;
    transition: width 0.3s ease;
  }

  .bar-segment.normal { background: #2ecc71; }
  .bar-segment.gen-fail { background: #e74c3c; }
  .bar-segment.ret-fail { background: #f39c12; }
  .bar-segment.robust { background: #3498db; }
  .bar-segment.unclassified { background: #666; }

  /* Stats Row */
  .stats-row {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  .stat-item {
    text-align: center;
    min-width: 80px;
  }

  .stat-value {
    font-size: 1.4rem;
    font-weight: 600;
    color: #fff;
  }

  .stat-label {
    font-size: 0.75rem;
    color: #888;
    margin-top: 2px;
  }

  /* Preference Samples */
  .pref-samples-section {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #444;
  }

  .pref-filter-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .pref-filter-row h3 {
    font-size: 0.95rem;
    color: #ccc;
  }

  .filter-tabs {
    display: flex;
    gap: 4px;
  }

  .filter-tab {
    padding: 5px 14px;
    border: 1px solid #444;
    background: transparent;
    color: #999;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .filter-tab:hover {
    border-color: #666;
    color: #ccc;
  }

  .filter-tab.active {
    background: #4da3ff;
    border-color: #4da3ff;
    color: #fff;
  }

  .samples-table-wrapper {
    overflow-x: auto;
  }

  .samples-table th.col-question,
  .samples-table td.sample-question {
    text-align: left;
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sample-answer {
    color: #aaa;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .sample-quality {
    white-space: nowrap;
  }

  .halluc-tag {
    display: inline-block;
    font-size: 0.65rem;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(220, 53, 69, 0.25);
    color: #dc3545;
    margin-left: 4px;
    font-weight: 600;
  }

  .label-badge {
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: 3px;
    font-weight: 500;
  }

  .label-badge.chosen {
    background: rgba(40, 167, 69, 0.2);
    color: #28a745;
  }

  .label-badge.rejected {
    background: rgba(220, 53, 69, 0.2);
    color: #dc3545;
  }

  .label-badge.neutral {
    background: rgba(255, 255, 255, 0.08);
    color: #888;
  }

  .sample-source {
    font-size: 0.75rem;
    color: #888;
  }

  /* Models */
  .models-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .model-item {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    background: #373737;
    border-radius: 6px;
    border-left: 3px solid #444;
  }

  .model-item.active {
    border-left-color: #28a745;
  }

  .model-info {
    flex: 1;
  }

  .model-name {
    font-size: 0.9rem;
    color: #fff;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .model-meta {
    font-size: 0.75rem;
    color: #888;
    margin-top: 2px;
  }

  .model-path {
    font-size: 0.7rem;
    color: #666;
    font-family: 'JetBrains Mono', monospace;
    margin-top: 2px;
  }

  .btn-sm {
    padding: 6px 14px;
    font-size: 0.8rem;
  }

  /* Judge runs row */
  .judge-runs-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .runs-label {
    font-size: 0.8rem;
    color: #999;
    white-space: nowrap;
  }

  .runs-input {
    width: 60px;
    padding: 4px 8px;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 4px;
    color: #fff;
    font-size: 0.85rem;
    text-align: center;
  }

  .runs-input:focus {
    outline: none;
    border-color: #4da3ff;
  }

  .runs-hint {
    font-size: 0.75rem;
    color: #666;
    font-style: italic;
  }

  /* Control Panel */
  .control-panel {
    border: 1px solid #444;
  }

  .controls-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }

  @media (max-width: 768px) {
    .controls-grid {
      grid-template-columns: 1fr;
    }
  }

  .control-item {
    background: #373737;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .control-header h3 {
    font-size: 0.9rem;
    color: #fff;
    margin-bottom: 4px;
  }

  .control-desc {
    font-size: 0.8rem;
    color: #888;
    margin: 0;
  }

  .control-result {
    font-size: 0.8rem;
    color: #4da3ff;
    background: rgba(77, 163, 255, 0.1);
    padding: 8px 10px;
    border-radius: 4px;
    word-break: break-all;
  }

  /* Clickable failure counts */
  .failure-link {
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.85rem;
    padding: 2px 6px;
    border-radius: 3px;
    transition: background 0.15s ease;
    color: #fff;
    white-space: nowrap;
  }

  .failure-link:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
  }

  .failure-link:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .failure-link.normal-count { color: #2ecc71; }
  .failure-link.gen-fail { color: #e74c3c; }
  .failure-link.ret-fail { color: #f39c12; }
  .failure-link.robust { color: #3498db; }

  /* Clickable bar segments */
  .bar-segment {
    border: none;
    padding: 0;
    cursor: pointer;
    opacity: 0.9;
  }

  .bar-segment:hover {
    opacity: 1;
    filter: brightness(1.15);
  }

  /* Detail panel */
  .detail-panel {
    margin-top: 20px;
    padding: 16px;
    background: #333;
    border-radius: 8px;
    border: 1px solid #444;
  }

  .detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .detail-header h3 {
    font-size: 0.95rem;
    color: #ccc;
  }

  .detail-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail-row {
    border-radius: 4px;
    overflow: hidden;
  }

  .detail-row-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: #3a3a3a;
    border: none;
    cursor: pointer;
    text-align: left;
    color: #ccc;
    font-size: 0.82rem;
    transition: background 0.12s ease;
  }

  .detail-row-header:hover {
    background: #424242;
  }

  .detail-row.expanded .detail-row-header {
    background: #424242;
    border-bottom: 1px solid #555;
  }

  .detail-pipeline {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    flex-shrink: 0;
    width: 45px;
  }

  .detail-question {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #eee;
  }

  .detail-scores {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: #999;
    white-space: nowrap;
  }

  .detail-recall {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: #888;
    width: 60px;
    text-align: right;
  }

  .detail-expand {
    flex-shrink: 0;
    font-size: 0.7rem;
    color: #666;
    width: 16px;
    text-align: center;
  }

  .detail-answer {
    padding: 14px 16px;
    background: #353535;
    border-top: none;
  }

  .detail-answer-label {
    font-size: 0.75rem;
    color: #888;
    margin-bottom: 6px;
    font-weight: 500;
  }

  .detail-answer-text {
    font-size: 0.85rem;
    color: #ddd;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
  }

  .detail-meta {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #444;
    font-size: 0.75rem;
    color: #888;
  }

  /* Failure type badges */
  .ft-badge {
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: 3px;
    font-weight: 500;
    white-space: nowrap;
  }

  .ft-normal { background: rgba(46, 204, 113, 0.15); color: #2ecc71; }
  .ft-gen-fail { background: rgba(231, 76, 60, 0.15); color: #e74c3c; }
  .ft-ret-fail { background: rgba(243, 156, 18, 0.15); color: #f39c12; }
  .ft-robust { background: rgba(52, 152, 219, 0.15); color: #3498db; }
  .ft-unclassified { background: rgba(255, 255, 255, 0.05); color: #888; }

  /* Pipeline badge in samples table */
  .pipeline-badge {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
  }

  .pipeline-badge.pipeline-chunk { color: #4da3ff; }
  .pipeline-badge.pipeline-fact { color: #28a745; }
  .pipeline-badge.pipeline-llm { color: #9b59b6; }

  /* Run comparison delta styles */
  .run-comparison-hint {
    font-size: 0.78rem;
    color: #666;
    margin-bottom: 12px;
  }

  .score-delta {
    font-size: 0.68rem;
    margin-top: 1px;
    font-weight: 500;
  }

  .delta-up   { color: #2ecc71; }
  .delta-down { color: #e74c3c; }

  .ft-delta {
    font-size: 0.7rem;
    margin-left: 4px;
    font-weight: 500;
  }
</style>
