<!-- src/routes/compare/+page.svelte -->
<script lang="ts">
  import type { PageData } from './$types';
  import type { ComparisonPayload } from '$lib/server/compare/types';

  let { data }: { data: PageData } = $props();

  let fileA = $state<File | null>(null);
  let fileB = $state<File | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let result = $state<(ComparisonPayload & { id: string }) | null>(null);

  async function readJson(f: File): Promise<unknown> {
    return JSON.parse(await f.text());
  }

  async function run() {
    error = null;
    if (!fileA || !fileB) { error = 'Select both report files.'; return; }
    loading = true;
    try {
      const [reportA, reportB] = await Promise.all([readJson(fileA), readJson(fileB)]);
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportA, reportB }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Compare failed');
      result = json;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const fmt = (n: number | null, d = 3) => (n == null ? '—' : n.toFixed(d));
  const failureTypes = ['normal', 'generation_failure', 'retrieval_failure', 'robust_generation', 'hallucination_failure', 'unclassified'];
</script>

<h1>Compare two RAG reports</h1>

<section class="upload">
  <label>Report A <input type="file" accept="application/json"
    onchange={(e) => (fileA = e.currentTarget.files?.[0] ?? null)} /></label>
  <label>Report B <input type="file" accept="application/json"
    onchange={(e) => (fileB = e.currentTarget.files?.[0] ?? null)} /></label>
  <button onclick={run} disabled={loading}>{loading ? 'Judging…' : 'Compare'}</button>
</section>

{#if error}<p class="error">{error}</p>{/if}

{#if result}
  {#if result.versionMismatch}
    <p class="warn">⚠ Question-set versions differ
      ({result.reportA.questionSetVersion} vs {result.reportB.questionSetVersion}).
      Metrics may not be comparable.</p>
  {/if}

  <h2>Summary</h2>
  <table>
    <thead><tr><th>Metric</th><th>{result.aggregates.a.systemLabel}</th><th>{result.aggregates.b.systemLabel}</th></tr></thead>
    <tbody>
      <tr><td>Groundedness</td><td>{fmt(result.aggregates.a.judge.groundedness)}</td><td>{fmt(result.aggregates.b.judge.groundedness)}</td></tr>
      <tr><td>Completeness</td><td>{fmt(result.aggregates.a.judge.completeness)}</td><td>{fmt(result.aggregates.b.judge.completeness)}</td></tr>
      <tr><td>Correctness</td><td>{fmt(result.aggregates.a.judge.correctness)}</td><td>{fmt(result.aggregates.b.judge.correctness)}</td></tr>
      <tr><td>Judge mean</td><td>{fmt(result.aggregates.a.judge.judgeMean)}</td><td>{fmt(result.aggregates.b.judge.judgeMean)}</td></tr>
      <tr><td>Hallucination rate</td><td>{fmt(result.aggregates.a.hallucinationRate)}</td><td>{fmt(result.aggregates.b.hallucinationRate)}</td></tr>
      <tr><td>Answerable rate</td><td>{fmt(result.aggregates.a.answerableRate)}</td><td>{fmt(result.aggregates.b.answerableRate)}</td></tr>
      <tr><td>Avg total latency (ms)</td><td>{fmt(result.latency.a.totalMs, 0)}</td><td>{fmt(result.latency.b.totalMs, 0)}</td></tr>
      <tr><td>Avg retrieval latency (ms)</td><td>{fmt(result.latency.a.retrievalMs, 0)}</td><td>{fmt(result.latency.b.retrievalMs, 0)}</td></tr>
      <tr><td>Avg generation latency (ms)</td><td>{fmt(result.latency.a.generationMs, 0)}</td><td>{fmt(result.latency.b.generationMs, 0)}</td></tr>
    </tbody>
  </table>

  <h2>Failure types</h2>
  <table>
    <thead><tr><th>Type</th><th>{result.aggregates.a.systemLabel}</th><th>{result.aggregates.b.systemLabel}</th></tr></thead>
    <tbody>
      {#each failureTypes as ft}
        <tr><td>{ft}</td>
          <td>{result.aggregates.a.failureTypeCounts[ft] ?? 0}</td>
          <td>{result.aggregates.b.failureTypeCounts[ft] ?? 0}</td></tr>
      {/each}
    </tbody>
  </table>

  <p class="saved">Saved as comparison <code>{result.id}</code></p>
{/if}

{#if data.comparisons.length}
  <h2>Previous comparisons</h2>
  <ul>
    {#each data.comparisons as c}
      <li><a href={`/api/compare/${c.id}`}>{c.labelA} vs {c.labelB}</a> — {new Date(c.createdAt).toLocaleString()}</li>
    {/each}
  </ul>
{/if}

<style>
  .upload { display: flex; gap: 1rem; align-items: end; margin: 1rem 0; flex-wrap: wrap; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.35rem 0.75rem; text-align: left; }
  .error { color: #b00; }
  .warn { color: #a60; }
  .saved { color: #555; font-size: 0.9rem; }
</style>
