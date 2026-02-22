<script lang="ts">
  import { onMount } from 'svelte';

  interface DocumentCoverageMetrics {
    avgChunksPerExpectedDoc: number;
    percentDocsWithMultipleChunks: number;
  }

  interface CompressionMetrics {
    avgCompressionRatio: number;
    minCompressionRatio: number;
    maxCompressionRatio: number;
  }

  interface PipelineMetrics {
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    ndcg: number;
    hitAt1: number;
    hitAt5: number;
    hitAt10: number;
    avgLatencyMs: number;
    avgScore?: number;
    queryCount: number;
    sourceDiversity?: number;
    documentCoverage?: DocumentCoverageMetrics;
    compression?: CompressionMetrics;
  }

  interface OverlapMetrics {
    avgChunkFact: number;
    avgChunkLlm: number;
    avgFactLlm: number;
    embeddingChunkFact?: number;
    embeddingChunkLlm?: number;
    embeddingFactLlm?: number;
  }

  interface EvaluationRun {
    id: string;
    name: string | null;
    pipeline: string;
    config: {
      topK: number;
      rerank: boolean;
    };
    metrics: {
      chunk?: PipelineMetrics;
      fact?: PipelineMetrics;
      llm?: PipelineMetrics;
      overlap?: OverlapMetrics;
    };
    status: string;
    startedAt: string;
    completedAt: string | null;
  }

  interface TestQuery {
    id: string;
    query: string;
    expectedDocumentIds: string[];
    category: string | null;
    difficulty: string;
    createdAt: string;
  }

  interface Document {
    id: string;
    url: string;
    title: string | null;
    domain: string;
  }

  interface QueryMetricsData {
    recallAt10: number;
    mrr: number;
    ndcg: number;
    hitAt1: number;
    [key: string]: number;
  }

  interface QueryBreakdown {
    query: string;
    category: string | null;
    difficulty: string;
    chunk?: QueryMetricsData & { latencyMs: number };
    fact?: QueryMetricsData & { latencyMs: number };
    llm?: QueryMetricsData & { latencyMs: number };
  }

  interface GroupBreakdown {
    name: string;
    count: number;
    chunk: { avgRecall: number; avgMRR: number };
    fact: { avgRecall: number; avgMRR: number };
    llm: { avgRecall: number; avgMRR: number };
  }

  // State
  let runs = $state<EvaluationRun[]>([]);
  let testQueries = $state<TestQuery[]>([]);
  let documents = $state<Document[]>([]);
  let loading = $state(true);
  let error = $state('');

  // Run evaluation state
  let runName = $state('');
  let topK = $state(10);
  let useRerank = $state(true);
  let isRunning = $state(false);
  let runError = $state('');

  // Add test query state
  let newQuery = $state('');
  let newCategory = $state('');
  let newDifficulty = $state<'easy' | 'medium' | 'hard'>('medium');
  let selectedDocIds = $state<Set<string>>(new Set());
  let showDocSelector = $state(false);
  let docSearchFilter = $state('');
  let addingQuery = $state(false);

  // Per-query results from latest evaluation
  let latestQueryResults = $state<{
    chunk: Array<Record<string, unknown>>;
    fact: Array<Record<string, unknown>>;
    llm: Array<Record<string, unknown>>;
  } | null>(null);

  // Filtered documents based on search
  let filteredDocs = $derived.by(() => {
    if (!docSearchFilter.trim()) return documents;
    const search = docSearchFilter.toLowerCase();
    return documents.filter(d =>
      d.title?.toLowerCase().includes(search) ||
      d.url.toLowerCase().includes(search) ||
      d.domain.toLowerCase().includes(search)
    );
  });

  // Latest run for comparison
  let latestRun = $derived.by(() => {
    const completed = runs.filter((r) => r.status === 'completed');
    return completed[0] || null;
  });

  // Previous completed run for delta comparison
  let previousRun = $derived.by(() => {
    const completed = runs.filter((r) => r.status === 'completed');
    return completed.length >= 2 ? completed[1] : null;
  });

  // Join per-query results by query text for breakdown view
  let queryBreakdowns = $derived.by((): QueryBreakdown[] => {
    if (!latestQueryResults) return [];
    const byQuery = new Map<string, QueryBreakdown>();

    for (const pipeline of ['chunk', 'fact', 'llm'] as const) {
      const results = latestQueryResults[pipeline] || [];
      for (const r of results) {
        const q = r.query as string;
        if (!byQuery.has(q)) {
          byQuery.set(q, {
            query: q,
            category: r.category as string | null,
            difficulty: r.difficulty as string,
          });
        }
        const entry = byQuery.get(q)!;
        const metrics = r.metrics as Record<string, number>;
        entry[pipeline] = {
          recallAt10: metrics.recallAt10 ?? 0,
          mrr: metrics.mrr ?? 0,
          ndcg: metrics.ndcg ?? 0,
          hitAt1: metrics.hitAt1 ?? 0,
          latencyMs: r.latency_ms as number,
        };
      }
    }

    return [...byQuery.values()];
  });

  // Group breakdowns by a key
  function computeGroupBreakdowns(breakdowns: QueryBreakdown[], key: 'category' | 'difficulty'): GroupBreakdown[] {
    const groups = new Map<string, QueryBreakdown[]>();
    for (const q of breakdowns) {
      const name = key === 'category' ? (q.category || 'uncategorized') : q.difficulty;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(q);
    }

    return [...groups.entries()].map(([name, queries]) => {
      const avg = (p: 'chunk' | 'fact' | 'llm', field: 'recallAt10' | 'mrr') => {
        const vals = queries.filter(q => q[p]).map(q => q[p]![field]);
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      };

      return {
        name,
        count: queries.length,
        chunk: { avgRecall: avg('chunk', 'recallAt10'), avgMRR: avg('chunk', 'mrr') },
        fact: { avgRecall: avg('fact', 'recallAt10'), avgMRR: avg('fact', 'mrr') },
        llm: { avgRecall: avg('llm', 'recallAt10'), avgMRR: avg('llm', 'mrr') },
      };
    });
  }

  let categoryBreakdowns = $derived(computeGroupBreakdowns(queryBreakdowns, 'category'));
  let difficultyBreakdowns = $derived(computeGroupBreakdowns(queryBreakdowns, 'difficulty'));

  async function loadData() {
    loading = true;
    error = '';

    try {
      const [runsRes, queriesRes, docsRes, latestRes] = await Promise.all([
        fetch('/api/evaluate'),
        fetch('/api/test-queries'),
        fetch('/api/documents'),
        fetch('/api/evaluate/latest'),
      ]);

      if (runsRes.ok) {
        const data = await runsRes.json();
        runs = data.runs || [];
      }

      if (queriesRes.ok) {
        const data = await queriesRes.json();
        testQueries = data.queries || [];
      }

      if (docsRes.ok) {
        const data = await docsRes.json();
        documents = data.documents || [];
      }

      if (latestRes.ok) {
        const data = await latestRes.json();
        latestQueryResults = data.results || null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data';
    } finally {
      loading = false;
    }
  }

  async function runEvaluation() {
    if (testQueries.length === 0) {
      runError = 'Add at least one test query before running evaluation';
      return;
    }

    isRunning = true;
    runError = '';

    try {
      const res = await fetch('/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: runName || null,
          topK,
          rerank: useRerank,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Evaluation failed');
      }

      runName = '';
      await loadData();
    } catch (e) {
      runError = e instanceof Error ? e.message : 'Evaluation failed';
    } finally {
      isRunning = false;
    }
  }

  async function addTestQuery() {
    if (!newQuery.trim()) return;

    addingQuery = true;

    try {
      const res = await fetch('/api/test-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: newQuery,
          category: newCategory || null,
          difficulty: newDifficulty,
          expectedDocumentIds: Array.from(selectedDocIds),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add query');
      }

      newQuery = '';
      newCategory = '';
      newDifficulty = 'medium';
      selectedDocIds = new Set();
      showDocSelector = false;
      docSearchFilter = '';
      await loadData();
    } catch (e) {
      console.error('Failed to add query:', e);
    } finally {
      addingQuery = false;
    }
  }

  function toggleDocSelection(docId: string) {
    const newSet = new Set(selectedDocIds);
    if (newSet.has(docId)) {
      newSet.delete(docId);
    } else {
      newSet.add(docId);
    }
    selectedDocIds = newSet;
  }

  function clearDocSelection() {
    selectedDocIds = new Set();
  }

  async function deleteTestQuery(id: string) {
    try {
      await fetch('/api/test-queries', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await loadData();
    } catch (e) {
      console.error('Failed to delete query:', e);
    }
  }

  function formatPercent(n: number | undefined): string {
    if (n === undefined || isNaN(n)) return '0%';
    return (n * 100).toFixed(1) + '%';
  }

  function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleString();
  }

  function scoreClass(score: number | undefined): string {
    if (score === undefined) return 'score-none';
    if (score >= 0.8) return 'score-high';
    if (score >= 0.3) return 'score-medium';
    return 'score-low';
  }

  function metricDelta(current: number | undefined, previous: number | undefined): { value: string; cls: string } | null {
    if (current === undefined || previous === undefined) return null;
    const delta = current - previous;
    if (Math.abs(delta) < 0.005) return null;
    return {
      value: (delta > 0 ? '+' : '') + (delta * 100).toFixed(1) + '%',
      cls: delta > 0 ? 'positive' : 'negative',
    };
  }

  function latencyDeltaFmt(current: number | undefined, previous: number | undefined): { value: string; cls: string } | null {
    if (current === undefined || previous === undefined) return null;
    const delta = current - previous;
    if (Math.abs(delta) < 1) return null;
    return {
      value: (delta > 0 ? '+' : '') + delta.toFixed(0) + 'ms',
      cls: delta < 0 ? 'positive' : 'negative',
    };
  }

  function getMetric(run: EvaluationRun | null, pipeline: string, metric: string): number | undefined {
    if (!run?.metrics) return undefined;
    const pm = (run.metrics as Record<string, PipelineMetrics | OverlapMetrics | undefined>)[pipeline] as PipelineMetrics | undefined;
    return pm ? (pm as unknown as Record<string, number>)[metric] : undefined;
  }

  onMount(() => {
    loadData();
  });
</script>

<svelte:head>
  <title>Evaluate - RAG Lab</title>
</svelte:head>

<div class="evaluate-page">
  <header class="page-header">
    <h1>Evaluation</h1>
    <p class="subtitle">Compare pipeline performance side-by-side</p>
  </header>

  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Loading evaluation data...</span>
    </div>
  {:else}
    <!-- Latest Results Comparison -->
    {#if latestRun && latestRun.metrics}
      <section class="card comparison-section">
        <h2>Latest Results Comparison</h2>
        <p class="run-info">
          {latestRun.name || 'Unnamed run'} - {formatDate(latestRun.completedAt || latestRun.startedAt)}
        </p>

        <div class="metrics-comparison three-col">
          {#if latestRun.metrics.chunk}
            <div class="metrics-card chunk">
              <h3>Chunk Pipeline</h3>
              <div class="metrics-grid extended">
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.chunk.recallAt5)}</span>
                  <span class="metric-label">Recall@5</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.chunk.recallAt10)}</span>
                  <span class="metric-label">Recall@10</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{(latestRun.metrics.chunk.mrr ?? 0).toFixed(3)}</span>
                  <span class="metric-label">MRR</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.chunk.hitAt1)}</span>
                  <span class="metric-label">Hit@1</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.chunk.hitAt5)}</span>
                  <span class="metric-label">Hit@5</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{(latestRun.metrics.chunk.avgLatencyMs ?? 0).toFixed(0)}ms</span>
                  <span class="metric-label">Latency</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.chunk.sourceDiversity)}</span>
                  <span class="metric-label">Diversity</span>
                </div>
                {#if latestRun.metrics.chunk.documentCoverage}
                  <div class="metric">
                    <span class="metric-value">{latestRun.metrics.chunk.documentCoverage.avgChunksPerExpectedDoc.toFixed(1)}</span>
                    <span class="metric-label">Chunks/Doc</span>
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          {#if latestRun.metrics.fact}
            <div class="metrics-card fact">
              <h3>Fact Pipeline</h3>
              <div class="metrics-grid extended">
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.fact.recallAt5)}</span>
                  <span class="metric-label">Recall@5</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.fact.recallAt10)}</span>
                  <span class="metric-label">Recall@10</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{(latestRun.metrics.fact.mrr ?? 0).toFixed(3)}</span>
                  <span class="metric-label">MRR</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.fact.hitAt1)}</span>
                  <span class="metric-label">Hit@1</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.fact.hitAt5)}</span>
                  <span class="metric-label">Hit@5</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{(latestRun.metrics.fact.avgLatencyMs ?? 0).toFixed(0)}ms</span>
                  <span class="metric-label">Latency</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.fact.sourceDiversity)}</span>
                  <span class="metric-label">Diversity</span>
                </div>
                {#if latestRun.metrics.fact.documentCoverage}
                  <div class="metric">
                    <span class="metric-value">{latestRun.metrics.fact.documentCoverage.avgChunksPerExpectedDoc.toFixed(1)}</span>
                    <span class="metric-label">Chunks/Doc</span>
                  </div>
                {/if}
              </div>
              {#if latestRun.metrics.fact.compression}
                <div class="compression-info">
                  <span class="compression-label">Compression: <span class="tooltip-icon" data-tooltip="How much this pipeline condenses source content. A 2x ratio means retrieved items contain roughly half the tokens of the original chunks they came from.">?</span></span>
                  <span class="compression-value">{latestRun.metrics.fact.compression.avgCompressionRatio.toFixed(1)}x</span>
                </div>
              {/if}
            </div>
          {/if}

          {#if latestRun.metrics.llm}
            <div class="metrics-card llm">
              <h3>LLM Pipeline</h3>
              <div class="metrics-grid extended">
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.llm.recallAt5)}</span>
                  <span class="metric-label">Recall@5</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.llm.recallAt10)}</span>
                  <span class="metric-label">Recall@10</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{(latestRun.metrics.llm.mrr ?? 0).toFixed(3)}</span>
                  <span class="metric-label">MRR</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.llm.hitAt1)}</span>
                  <span class="metric-label">Hit@1</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.llm.hitAt5)}</span>
                  <span class="metric-label">Hit@5</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{(latestRun.metrics.llm.avgLatencyMs ?? 0).toFixed(0)}ms</span>
                  <span class="metric-label">Latency</span>
                </div>
                <div class="metric">
                  <span class="metric-value">{formatPercent(latestRun.metrics.llm.sourceDiversity)}</span>
                  <span class="metric-label">Diversity</span>
                </div>
                {#if latestRun.metrics.llm.documentCoverage}
                  <div class="metric">
                    <span class="metric-value">{latestRun.metrics.llm.documentCoverage.avgChunksPerExpectedDoc.toFixed(1)}</span>
                    <span class="metric-label">Chunks/Doc</span>
                  </div>
                {/if}
              </div>
              {#if latestRun.metrics.llm.compression}
                <div class="compression-info">
                  <span class="compression-label">Compression: <span class="tooltip-icon" data-tooltip="How much this pipeline condenses source content. A 2x ratio means retrieved items contain roughly half the tokens of the original chunks they came from.">?</span></span>
                  <span class="compression-value">{latestRun.metrics.llm.compression.avgCompressionRatio.toFixed(1)}x</span>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Overlap metrics (Jaccard on chunk IDs) -->
        {#if latestRun.metrics.overlap}
          <div class="overlap-section">
            <h3>Result Overlap (Jaccard Similarity on Document IDs) <span class="tooltip-icon" data-tooltip="What fraction of retrieved source documents are shared between pipelines. 100% means both pipelines returned the exact same documents; 0% means no overlap at all.">?</span></h3>
            <div class="overlap-grid">
              <div class="overlap-item">
                <div class="overlap-pair">
                  <span class="badge-small chunk">Chunk</span>
                  <span class="overlap-vs">vs</span>
                  <span class="badge-small fact">Fact</span>
                </div>
                <div class="overlap-bar">
                  <div class="overlap-fill" style="width: {(latestRun.metrics.overlap.avgChunkFact || 0) * 100}%"></div>
                </div>
                <span class="overlap-value">{formatPercent(latestRun.metrics.overlap.avgChunkFact)}</span>
              </div>
              <div class="overlap-item">
                <div class="overlap-pair">
                  <span class="badge-small chunk">Chunk</span>
                  <span class="overlap-vs">vs</span>
                  <span class="badge-small llm">LLM</span>
                </div>
                <div class="overlap-bar">
                  <div class="overlap-fill" style="width: {(latestRun.metrics.overlap.avgChunkLlm || 0) * 100}%"></div>
                </div>
                <span class="overlap-value">{formatPercent(latestRun.metrics.overlap.avgChunkLlm)}</span>
              </div>
              <div class="overlap-item">
                <div class="overlap-pair">
                  <span class="badge-small fact">Fact</span>
                  <span class="overlap-vs">vs</span>
                  <span class="badge-small llm">LLM</span>
                </div>
                <div class="overlap-bar">
                  <div class="overlap-fill" style="width: {(latestRun.metrics.overlap.avgFactLlm || 0) * 100}%"></div>
                </div>
                <span class="overlap-value">{formatPercent(latestRun.metrics.overlap.avgFactLlm)}</span>
              </div>
            </div>
          </div>
        {/if}

        <!-- Embedding similarity section -->
        {#if latestRun.metrics.overlap?.embeddingChunkFact !== undefined}
          <div class="overlap-section">
            <h3>Content Similarity (Embedding Overlap) <span class="tooltip-icon" data-tooltip="Average cosine similarity between the embedded text of each pipeline's results. High similarity means pipelines retrieved semantically related content, even if from different documents.">?</span></h3>
            <div class="overlap-grid">
              <div class="overlap-item">
                <div class="overlap-pair">
                  <span class="badge-small chunk">Chunk</span>
                  <span class="overlap-vs">vs</span>
                  <span class="badge-small fact">Fact</span>
                </div>
                <div class="overlap-bar">
                  <div class="overlap-fill semantic" style="width: {(latestRun.metrics.overlap.embeddingChunkFact || 0) * 100}%"></div>
                </div>
                <span class="overlap-value">{formatPercent(latestRun.metrics.overlap.embeddingChunkFact)}</span>
              </div>
              <div class="overlap-item">
                <div class="overlap-pair">
                  <span class="badge-small chunk">Chunk</span>
                  <span class="overlap-vs">vs</span>
                  <span class="badge-small llm">LLM</span>
                </div>
                <div class="overlap-bar">
                  <div class="overlap-fill semantic" style="width: {(latestRun.metrics.overlap.embeddingChunkLlm || 0) * 100}%"></div>
                </div>
                <span class="overlap-value">{formatPercent(latestRun.metrics.overlap.embeddingChunkLlm)}</span>
              </div>
              <div class="overlap-item">
                <div class="overlap-pair">
                  <span class="badge-small fact">Fact</span>
                  <span class="overlap-vs">vs</span>
                  <span class="badge-small llm">LLM</span>
                </div>
                <div class="overlap-bar">
                  <div class="overlap-fill semantic" style="width: {(latestRun.metrics.overlap.embeddingFactLlm || 0) * 100}%"></div>
                </div>
                <span class="overlap-value">{formatPercent(latestRun.metrics.overlap.embeddingFactLlm)}</span>
              </div>
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <!-- Run-over-Run Comparison -->
    {#if latestRun && previousRun?.metrics}
      <section class="card">
        <h2>Run-over-Run Comparison</h2>
        <p class="section-description">
          {latestRun.name || 'Latest'} vs {previousRun.name || 'Previous'} ({formatDate(previousRun.completedAt || previousRun.startedAt)})
        </p>

        <div class="comparison-table-wrapper">
          <table class="comparison-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th class="col-chunk">Chunk</th>
                <th class="col-fact">Fact</th>
                <th class="col-llm">LLM</th>
              </tr>
            </thead>
            <tbody>
              {#each [
                { metric: 'recallAt5', label: 'Recall@5', fmt: 'pct' },
                { metric: 'recallAt10', label: 'Recall@10', fmt: 'pct' },
                { metric: 'mrr', label: 'MRR', fmt: 'dec' },
                { metric: 'ndcg', label: 'nDCG', fmt: 'dec' },
                { metric: 'hitAt1', label: 'Hit@1', fmt: 'pct' },
                { metric: 'hitAt5', label: 'Hit@5', fmt: 'pct' },
              ] as row}
                <tr>
                  <td class="metric-name-cell">{row.label}</td>
                  {#each ['chunk', 'fact', 'llm'] as p}
                    {@const cur = getMetric(latestRun, p, row.metric)}
                    {@const prev = getMetric(previousRun, p, row.metric)}
                    {@const d = metricDelta(cur, prev)}
                    <td class="delta-cell">
                      {#if cur !== undefined}
                        <span class="current-val">{row.fmt === 'pct' ? formatPercent(cur) : cur.toFixed(3)}</span>
                        {#if d}<span class="delta {d.cls}">{d.value}</span>{/if}
                      {:else}
                        <span class="no-data">-</span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
              <tr>
                <td class="metric-name-cell">Latency</td>
                {#each ['chunk', 'fact', 'llm'] as p}
                  {@const cur = getMetric(latestRun, p, 'avgLatencyMs')}
                  {@const prev = getMetric(previousRun, p, 'avgLatencyMs')}
                  {@const d = latencyDeltaFmt(cur, prev)}
                  <td class="delta-cell">
                    {#if cur !== undefined}
                      <span class="current-val">{cur.toFixed(0)}ms</span>
                      {#if d}<span class="delta {d.cls}">{d.value}</span>{/if}
                    {:else}
                      <span class="no-data">-</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <!-- Per-Query Breakdown -->
    {#if queryBreakdowns.length > 0}
      <section class="card">
        <h2>Per-Query Breakdown</h2>
        <p class="section-description">Individual query performance across pipelines. Color: green ({'>'}80%), yellow (30-80%), red ({'<'}30%).</p>

        <div class="query-table-wrapper">
          <table class="query-table">
            <thead>
              <tr>
                <th class="col-query">Query</th>
                <th class="col-meta">Info</th>
                <th class="col-chunk">Chunk R@10</th>
                <th class="col-fact">Fact R@10</th>
                <th class="col-llm">LLM R@10</th>
                <th class="col-chunk">Chunk MRR</th>
                <th class="col-fact">Fact MRR</th>
                <th class="col-llm">LLM MRR</th>
              </tr>
            </thead>
            <tbody>
              {#each queryBreakdowns as q}
                <tr>
                  <td class="query-cell" title={q.query}>
                    {q.query.length > 45 ? q.query.slice(0, 45) + '...' : q.query}
                  </td>
                  <td class="meta-cell">
                    {#if q.category}<span class="badge-tiny">{q.category}</span>{/if}
                    <span class="badge-tiny badge-{q.difficulty === 'easy' ? 'green' : q.difficulty === 'hard' ? 'red' : 'yellow'}">{q.difficulty}</span>
                  </td>
                  <td class="metric-cell {scoreClass(q.chunk?.recallAt10)}">{formatPercent(q.chunk?.recallAt10)}</td>
                  <td class="metric-cell {scoreClass(q.fact?.recallAt10)}">{formatPercent(q.fact?.recallAt10)}</td>
                  <td class="metric-cell {scoreClass(q.llm?.recallAt10)}">{formatPercent(q.llm?.recallAt10)}</td>
                  <td class="metric-cell {scoreClass(q.chunk?.mrr)}">{(q.chunk?.mrr ?? 0).toFixed(3)}</td>
                  <td class="metric-cell {scoreClass(q.fact?.mrr)}">{(q.fact?.mrr ?? 0).toFixed(3)}</td>
                  <td class="metric-cell {scoreClass(q.llm?.mrr)}">{(q.llm?.mrr ?? 0).toFixed(3)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <!-- Category & Difficulty Analysis -->
    {#if categoryBreakdowns.length > 1 || difficultyBreakdowns.length > 1}
      <section class="card">
        <h2>Performance by Category & Difficulty</h2>

        {#if categoryBreakdowns.length > 1}
          <h3 class="analysis-subtitle">By Category</h3>
          <div class="analysis-grid">
            {#each categoryBreakdowns as group}
              <div class="analysis-card">
                <div class="analysis-header">
                  <span class="analysis-name">{group.name}</span>
                  <span class="analysis-count">{group.count} {group.count === 1 ? 'query' : 'queries'}</span>
                </div>
                <div class="analysis-metrics">
                  <div class="analysis-row">
                    <span class="analysis-label">R@10</span>
                    <span class="analysis-val chunk">{formatPercent(group.chunk.avgRecall)}</span>
                    <span class="analysis-val fact">{formatPercent(group.fact.avgRecall)}</span>
                    <span class="analysis-val llm">{formatPercent(group.llm.avgRecall)}</span>
                  </div>
                  <div class="analysis-row">
                    <span class="analysis-label">MRR</span>
                    <span class="analysis-val chunk">{group.chunk.avgMRR.toFixed(3)}</span>
                    <span class="analysis-val fact">{group.fact.avgMRR.toFixed(3)}</span>
                    <span class="analysis-val llm">{group.llm.avgMRR.toFixed(3)}</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if difficultyBreakdowns.length > 1}
          <h3 class="analysis-subtitle">By Difficulty</h3>
          <div class="analysis-grid">
            {#each difficultyBreakdowns as group}
              <div class="analysis-card">
                <div class="analysis-header">
                  <span class="analysis-name badge badge-{group.name === 'easy' ? 'green' : group.name === 'hard' ? 'red' : 'yellow'}">{group.name}</span>
                  <span class="analysis-count">{group.count} {group.count === 1 ? 'query' : 'queries'}</span>
                </div>
                <div class="analysis-metrics">
                  <div class="analysis-row">
                    <span class="analysis-label">R@10</span>
                    <span class="analysis-val chunk">{formatPercent(group.chunk.avgRecall)}</span>
                    <span class="analysis-val fact">{formatPercent(group.fact.avgRecall)}</span>
                    <span class="analysis-val llm">{formatPercent(group.llm.avgRecall)}</span>
                  </div>
                  <div class="analysis-row">
                    <span class="analysis-label">MRR</span>
                    <span class="analysis-val chunk">{group.chunk.avgMRR.toFixed(3)}</span>
                    <span class="analysis-val fact">{group.fact.avgMRR.toFixed(3)}</span>
                    <span class="analysis-val llm">{group.llm.avgMRR.toFixed(3)}</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    <!-- Run Evaluation -->
    <section class="card">
      <h2>Run Evaluation</h2>

      <div class="run-form">
        <div class="form-row">
          <label>
            <span class="label-text">Run Name (optional)</span>
            <input type="text" class="input" bind:value={runName} placeholder="e.g., Baseline test" />
          </label>
          <label>
            <span class="label-text">Top K</span>
            <input type="number" class="input" bind:value={topK} min="1" max="100" />
          </label>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={useRerank} />
            <span>Use Reranking</span>
          </label>
        </div>

        <button class="btn btn-primary" onclick={runEvaluation} disabled={isRunning || testQueries.length === 0}>
          {#if isRunning}
            <span class="spinner-small"></span>
            Running all pipelines...
          {:else}
            Run Evaluation (All Pipelines)
          {/if}
        </button>

        {#if runError}
          <p class="error-text">{runError}</p>
        {/if}

        {#if testQueries.length === 0}
          <p class="warning-text">Add test queries below before running evaluation.</p>
        {/if}
      </div>
    </section>

    <!-- Test Queries Management -->
    <section class="card">
      <h2>Test Queries ({testQueries.length})</h2>
      <p class="section-description">Add queries to test how each pipeline retrieves relevant content.</p>

      <div class="add-query-form">
        <div class="form-row">
          <label class="query-input-label">
            <span class="label-text">Query</span>
            <input
              type="text"
              class="input"
              bind:value={newQuery}
              placeholder="Enter test query..."
            />
          </label>
        </div>
        <div class="form-row">
          <label>
            <span class="label-text">Category (optional)</span>
            <input type="text" class="input" bind:value={newCategory} placeholder="e.g., technical" />
          </label>
          <label>
            <span class="label-text">Difficulty</span>
            <select class="input" bind:value={newDifficulty}>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </label>
        </div>

        <!-- Expected Documents Selector -->
        <div class="expected-docs-section">
          <button
            type="button"
            class="doc-selector-toggle"
            onclick={() => showDocSelector = !showDocSelector}
          >
            <span class="toggle-icon">{showDocSelector ? '▼' : '▶'}</span>
            Expected Documents
            {#if selectedDocIds.size > 0}
              <span class="badge badge-blue">{selectedDocIds.size} selected</span>
            {:else}
              <span class="optional-hint">(optional - for IR metrics)</span>
            {/if}
          </button>

          {#if showDocSelector}
            <div class="doc-selector">
              {#if documents.length === 0}
                <p class="no-docs-hint">No documents indexed yet. Index some URLs first.</p>
              {:else}
                <div class="doc-selector-header">
                  <input
                    type="text"
                    class="input doc-search"
                    placeholder="Filter documents..."
                    bind:value={docSearchFilter}
                  />
                  {#if selectedDocIds.size > 0}
                    <button type="button" class="btn-link" onclick={clearDocSelection}>
                      Clear selection
                    </button>
                  {/if}
                </div>
                <div class="doc-list">
                  {#each filteredDocs as doc}
                    <label class="doc-option" class:selected={selectedDocIds.has(doc.id)}>
                      <input
                        type="checkbox"
                        checked={selectedDocIds.has(doc.id)}
                        onchange={() => toggleDocSelection(doc.id)}
                      />
                      <div class="doc-option-content">
                        <span class="doc-option-title">{doc.title || 'Untitled'}</span>
                        <span class="doc-option-url">{doc.url}</span>
                      </div>
                    </label>
                  {:else}
                    <p class="no-docs-hint">No documents match your filter.</p>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <button class="btn btn-secondary" onclick={addTestQuery} disabled={addingQuery || !newQuery.trim()}>
          {#if addingQuery}
            Adding...
          {:else}
            Add Query
          {/if}
        </button>
      </div>

      {#if testQueries.length > 0}
        <div class="queries-list">
          {#each testQueries as query}
            <div class="query-item">
              <div class="query-content">
                <div class="query-text">{query.query}</div>
                <div class="query-meta">
                  {#if query.category}
                    <span class="badge">{query.category}</span>
                  {/if}
                  <span class="badge badge-{query.difficulty === 'easy' ? 'green' : query.difficulty === 'hard' ? 'red' : 'yellow'}">
                    {query.difficulty}
                  </span>
                  {#if query.expectedDocumentIds && query.expectedDocumentIds.length > 0}
                    <span class="badge badge-blue" title="Expected documents for IR metrics">
                      {query.expectedDocumentIds.length} doc{query.expectedDocumentIds.length > 1 ? 's' : ''}
                    </span>
                  {:else}
                    <span class="badge badge-muted" title="No expected documents - IR metrics will be 0">
                      no ground truth
                    </span>
                  {/if}
                </div>
              </div>
              <button class="btn-icon" onclick={() => deleteTestQuery(query.id)} title="Delete query">
                x
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-queries">
          <p>No test queries yet. Add queries above to enable evaluation.</p>
        </div>
      {/if}
    </section>

    <!-- Past Runs -->
    {#if runs.length > 0}
      <section class="card">
        <h2>Evaluation History</h2>
        <div class="runs-list">
          {#each runs as run}
            <div class="run-item">
              <div class="run-info">
                <div class="run-name">{run.name || 'Unnamed run'}</div>
                <div class="run-date">{formatDate(run.startedAt)}</div>
              </div>
              <div class="run-status badge badge-{run.status === 'completed' ? 'green' : run.status === 'failed' ? 'red' : 'yellow'}">
                {run.status}
              </div>
              <div class="run-config">
                Top-{run.config.topK}
                {#if run.config.rerank}
                  + Rerank
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .evaluate-page {
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

  .section-description {
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
    margin-bottom: 16px;
  }

  .run-info {
    font-size: 0.85rem;
    color: #888;
    margin-bottom: 20px;
  }

  .metrics-comparison {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
    margin-bottom: 24px;
  }

  .metrics-comparison.three-col {
    grid-template-columns: repeat(3, 1fr);
  }

  @media (max-width: 900px) {
    .metrics-comparison.three-col {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 600px) {
    .metrics-comparison.three-col {
      grid-template-columns: 1fr;
    }
  }

  .metrics-card {
    background: #373737;
    border-radius: 8px;
    padding: 16px;
    border-top: 3px solid #444;
  }

  .metrics-card.chunk {
    border-top-color: #4da3ff;
  }

  .metrics-card.fact {
    border-top-color: #28a745;
  }

  .metrics-card.llm {
    border-top-color: #9b59b6;
  }

  .metrics-card h3 {
    font-size: 0.95rem;
    color: #ccc;
    margin-bottom: 16px;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .metrics-grid.extended {
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: center;
  }

  .metric-value {
    font-size: 1.1rem;
    font-weight: 600;
    color: #fff;
  }

  .metric-label {
    font-size: 0.7rem;
    color: #888;
  }

  .overlap-section {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #444;
  }

  .overlap-section h3 {
    font-size: 0.9rem;
    color: #ccc;
    margin-bottom: 16px;
  }

  .overlap-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }

  @media (max-width: 768px) {
    .overlap-grid {
      grid-template-columns: 1fr;
    }
  }

  .overlap-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .overlap-pair {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: center;
  }

  .overlap-vs {
    color: #666;
    font-size: 0.75rem;
  }

  .badge-small {
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 3px;
  }

  .badge-small.chunk {
    background: rgba(77, 163, 255, 0.2);
    color: #4da3ff;
  }

  .badge-small.fact {
    background: rgba(40, 167, 69, 0.2);
    color: #28a745;
  }

  .badge-small.llm {
    background: rgba(155, 89, 182, 0.2);
    color: #9b59b6;
  }

  .overlap-bar {
    height: 8px;
    background: #444;
    border-radius: 4px;
    overflow: hidden;
  }

  .overlap-fill {
    height: 100%;
    background: linear-gradient(90deg, #4da3ff, #9b59b6);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .overlap-fill.semantic {
    background: linear-gradient(90deg, #f39c12, #e74c3c);
  }

  .compression-info {
    display: flex;
    justify-content: space-between;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #444;
    font-size: 0.85rem;
  }

  .compression-label {
    color: #888;
  }

  .compression-value {
    color: #fff;
    font-weight: 500;
  }

  .overlap-value {
    text-align: center;
    font-size: 0.85rem;
    color: #ccc;
    font-weight: 500;
  }

  .run-form, .add-query-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .form-row {
    display: flex;
    gap: 16px;
    align-items: flex-end;
  }

  .form-row label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .query-input-label {
    flex: 1;
  }

  .label-text {
    font-size: 0.8rem;
    color: #888;
  }

  .checkbox-label {
    flex-direction: row !important;
    align-items: center !important;
    gap: 8px !important;
    color: #ccc;
    font-size: 0.9rem;
  }

  .error-text {
    color: #dc3545;
    font-size: 0.85rem;
  }

  .warning-text {
    color: #ffc107;
    font-size: 0.85rem;
  }

  .queries-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }

  .query-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: #373737;
    border-radius: 6px;
  }

  .query-content {
    flex: 1;
  }

  .query-text {
    font-size: 0.9rem;
    color: #fff;
    margin-bottom: 4px;
  }

  .query-meta {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn-icon {
    padding: 4px 8px;
    background: transparent;
    border: none;
    color: #888;
    font-size: 1.25rem;
    cursor: pointer;
    transition: color 0.15s ease;
  }

  .btn-icon:hover {
    color: #dc3545;
  }

  .empty-queries {
    text-align: center;
    padding: 20px;
    color: #888;
  }

  /* Expected Documents Selector */
  .expected-docs-section {
    margin: 8px 0;
  }

  .doc-selector-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #373737;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ccc;
    font-size: 0.85rem;
    cursor: pointer;
    width: 100%;
    text-align: left;
    transition: all 0.15s ease;
  }

  .doc-selector-toggle:hover {
    background: #404040;
    border-color: #555;
  }

  .toggle-icon {
    font-size: 0.7rem;
    color: #888;
  }

  .optional-hint {
    color: #666;
    font-size: 0.8rem;
    margin-left: auto;
  }

  .doc-selector {
    margin-top: 8px;
    padding: 12px;
    background: #373737;
    border: 1px solid #444;
    border-radius: 6px;
  }

  .doc-selector-header {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
  }

  .doc-search {
    flex: 1;
  }

  .btn-link {
    background: none;
    border: none;
    color: #4da3ff;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 4px 8px;
  }

  .btn-link:hover {
    text-decoration: underline;
  }

  .doc-list {
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .doc-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 10px;
    background: #2d2d2d;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .doc-option:hover {
    background: #353535;
  }

  .doc-option.selected {
    background: rgba(77, 163, 255, 0.15);
    border: 1px solid rgba(77, 163, 255, 0.3);
  }

  .doc-option input[type="checkbox"] {
    margin-top: 2px;
  }

  .doc-option-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .doc-option-title {
    font-size: 0.85rem;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .doc-option-url {
    font-size: 0.75rem;
    color: #888;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .no-docs-hint {
    color: #888;
    font-size: 0.85rem;
    text-align: center;
    padding: 16px;
  }

  .badge-muted {
    background: #444;
    color: #888;
  }

  .runs-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .run-item {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px;
    background: #373737;
    border-radius: 6px;
  }

  .run-item .run-info {
    flex: 1;
    margin-bottom: 0;
  }

  .run-name {
    font-size: 0.9rem;
    color: #fff;
  }

  .run-date {
    font-size: 0.75rem;
    color: #888;
  }

  .run-config {
    font-size: 0.8rem;
    color: #888;
  }

  /* Run-over-Run Comparison Table */
  .comparison-table-wrapper {
    overflow-x: auto;
  }

  .comparison-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .comparison-table th,
  .comparison-table td {
    padding: 8px 12px;
    text-align: center;
    border-bottom: 1px solid #444;
  }

  .comparison-table th {
    color: #888;
    font-weight: 500;
    font-size: 0.8rem;
  }

  .comparison-table th:first-child,
  .comparison-table td:first-child {
    text-align: left;
  }

  .col-chunk { color: #4da3ff; }
  .col-fact { color: #28a745; }
  .col-llm { color: #9b59b6; }

  .metric-name-cell {
    color: #ccc;
    font-weight: 500;
  }

  .delta-cell {
    white-space: nowrap;
  }

  .current-val {
    color: #fff;
  }

  .delta {
    font-size: 0.75rem;
    margin-left: 6px;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .delta.positive {
    color: #28a745;
    background: rgba(40, 167, 69, 0.15);
  }

  .delta.negative {
    color: #dc3545;
    background: rgba(220, 53, 69, 0.15);
  }

  .no-data {
    color: #666;
  }

  /* Per-Query Breakdown Table */
  .query-table-wrapper {
    overflow-x: auto;
  }

  .query-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  .query-table th,
  .query-table td {
    padding: 8px 10px;
    border-bottom: 1px solid #3a3a3a;
  }

  .query-table th {
    color: #888;
    font-weight: 500;
    font-size: 0.75rem;
    text-align: center;
    white-space: nowrap;
  }

  .query-table th.col-query {
    text-align: left;
  }

  .query-table th.col-meta {
    text-align: left;
  }

  .query-cell {
    color: #ddd;
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta-cell {
    white-space: nowrap;
  }

  .metric-cell {
    text-align: center;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .metric-cell.score-high {
    color: #28a745;
  }

  .metric-cell.score-medium {
    color: #ffc107;
  }

  .metric-cell.score-low {
    color: #dc3545;
  }

  .metric-cell.score-none {
    color: #666;
  }

  .badge-tiny {
    font-size: 0.65rem;
    padding: 1px 5px;
    border-radius: 3px;
    background: #444;
    color: #aaa;
    margin-right: 4px;
  }

  /* Category & Difficulty Analysis */
  .analysis-subtitle {
    font-size: 0.9rem;
    color: #ccc;
    margin: 20px 0 12px;
  }

  .analysis-subtitle:first-of-type {
    margin-top: 0;
  }

  .analysis-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .analysis-card {
    background: #373737;
    border-radius: 6px;
    padding: 12px;
  }

  .analysis-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .analysis-name {
    color: #fff;
    font-weight: 500;
    font-size: 0.85rem;
    text-transform: capitalize;
  }

  .analysis-count {
    color: #888;
    font-size: 0.75rem;
  }

  .analysis-metrics {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .analysis-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .analysis-label {
    color: #888;
    font-size: 0.75rem;
    width: 36px;
    flex-shrink: 0;
  }

  .analysis-val {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }

  .analysis-val.chunk {
    background: rgba(77, 163, 255, 0.15);
    color: #4da3ff;
  }

  .analysis-val.fact {
    background: rgba(40, 167, 69, 0.15);
    color: #28a745;
  }

  .analysis-val.llm {
    background: rgba(155, 89, 182, 0.15);
    color: #9b59b6;
  }

  @media (max-width: 768px) {
    .metrics-comparison {
      grid-template-columns: 1fr;
    }

    .form-row {
      flex-direction: column;
    }
  }

  /* Tooltip */
  .tooltip-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #555;
    color: #aaa;
    font-size: 0.65rem;
    font-weight: 700;
    cursor: default;
    position: relative;
    vertical-align: middle;
    margin-left: 4px;
    font-style: normal;
  }

  .tooltip-icon::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #1a1a1a;
    color: #ccc;
    font-size: 0.75rem;
    font-weight: 400;
    line-height: 1.4;
    padding: 7px 10px;
    border-radius: 5px;
    border: 1px solid #444;
    width: 240px;
    white-space: normal;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease;
    z-index: 10;
  }

  .tooltip-icon:hover::after {
    opacity: 1;
  }
</style>
