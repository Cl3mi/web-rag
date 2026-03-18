<script lang="ts">
  import { onMount } from 'svelte';

  interface ProcessingResult {
    documentId: string;
    status: string;
    url: string;
    title: string | null;
    wordCount: number;
    processingTimeMs: number;
    chunk: {
      chunkCount: number;
      processingTimeMs: number;
    };
    fact: {
      factCount: number;
      processingTimeMs: number;
    };
  }

  interface Document {
    id: string;
    url: string;
    title: string | null;
    domain: string;
    createdAt: string;
    updatedAt: string;
  }

  interface SitemapUrl {
    loc: string;
    lastmod?: string;
    priority?: number;
  }

  interface CrawlUrlResult {
    url: string;
    status: 'processed' | 'unchanged' | 'error';
    title: string | null;
    wordCount: number;
    chunkCount: number;
    factCount: number;
    llmChunkCount: number;
    processingTimeMs: number;
    error?: string;
  }

  // State
  let urlInput = $state('');
  let validationError = $state('');
  let isProcessing = $state(false);
  let processingStatus = $state('');
  let processingError = $state('');
  let lastResult = $state<ProcessingResult | null>(null);

  // Sitemap state
  let sitemapUrl = $state('');
  let sitemapUrls = $state<SitemapUrl[]>([]);
  let selectedUrls = $state<Set<string>>(new Set());
  let isPreviewing = $state(false);
  let isCrawling = $state(false);
  let crawlResults = $state<CrawlUrlResult[]>([]);
  let sitemapError = $state('');
  let crawlSummary = $state<{ total: number; processed: number; unchanged: number; failed: number } | null>(null);
  let exclusionPatterns = $state<string[]>([]);
  let exclusionInput = $state('');

  // URLs that match at least one exclusion pattern (derived, updates reactively)
  const excludedUrls = $derived(
    new Set(
      sitemapUrls
        .filter((su) => exclusionPatterns.some((p) => matchesExclusionPattern(su.loc, p)))
        .map((su) => su.loc)
    )
  );

  // Documents list
  let documents = $state<Document[]>([]);
  let loadingDocs = $state(true);

  // Toast notifications
  let toasts = $state<Array<{ id: number; type: 'success' | 'error'; message: string }>>([]);
  let toastId = $state(0);

  function showToast(type: 'success' | 'error', message: string) {
    const id = ++toastId;
    toasts = [...toasts, { id, type, message }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 5000);
  }

  function validateUrl(url: string): boolean {
    if (!url.trim()) {
      validationError = 'URL is required';
      return false;
    }
    try {
      let testUrl = url;
      if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
        testUrl = 'https://' + testUrl;
      }
      new URL(testUrl);
      validationError = '';
      return true;
    } catch {
      validationError = 'Invalid URL format';
      return false;
    }
  }

  async function loadDocuments() {
    loadingDocs = true;
    try {
      const res = await fetch('/api/metrics');
      if (res.ok) {
        const data = await res.json();
        documents = data.recentDocuments || [];
      }
    } catch (e) {
      console.error('Failed to load documents:', e);
    } finally {
      loadingDocs = false;
    }
  }

  async function processUrl() {
    if (!validateUrl(urlInput)) return;

    isProcessing = true;
    processingError = '';
    processingStatus = 'Fetching URL...';
    lastResult = null;

    try {
      let url = urlInput.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      processingStatus = 'Extracting content...';

      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Processing failed');
      }

      lastResult = data;

      if (data.status === 'unchanged') {
        showToast('success', 'Content unchanged, using existing data');
      } else {
        showToast(
          'success',
          `Processed: ${data.chunk.chunkCount} chunks, ${data.fact.factCount} facts`
        );
      }

      urlInput = '';
      await loadDocuments();
    } catch (error) {
      processingError = error instanceof Error ? error.message : 'Processing failed';
      showToast('error', processingError);
    } finally {
      isProcessing = false;
      processingStatus = '';
    }
  }

  function matchesExclusionPattern(url: string, pattern: string): boolean {
    try {
      const pathname = new URL(url).pathname;
      // Escape regex specials except *, then convert * → .*
      const regexStr = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp('^' + regexStr).test(pathname);
    } catch {
      return false;
    }
  }

  function addExclusionPattern() {
    const p = exclusionInput.trim();
    if (!p || exclusionPatterns.includes(p)) { exclusionInput = ''; return; }
    exclusionPatterns = [...exclusionPatterns, p];
    exclusionInput = '';
    // Auto-uncheck matching URLs
    const next = new Set(selectedUrls);
    for (const su of sitemapUrls) {
      if (matchesExclusionPattern(su.loc, p)) next.delete(su.loc);
    }
    selectedUrls = next;
  }

  function removeExclusionPattern(pattern: string) {
    exclusionPatterns = exclusionPatterns.filter((p) => p !== pattern);
  }

  function toggleSelectAll() {
    // Count currently selectable (non-excluded) URLs
    const selectable = sitemapUrls.filter((u) => !excludedUrls.has(u.loc));
    const allSelectableChosen = selectable.every((u) => selectedUrls.has(u.loc));
    if (allSelectableChosen) {
      // Deselect all (including excluded ones that may have been manually re-checked)
      selectedUrls = new Set();
    } else {
      // Select all non-excluded
      selectedUrls = new Set(selectable.map((u) => u.loc));
    }
  }

  function toggleUrl(loc: string) {
    const next = new Set(selectedUrls);
    if (next.has(loc)) {
      next.delete(loc);
    } else {
      next.add(loc);
    }
    selectedUrls = next;
  }

  async function previewSitemap() {
    if (!sitemapUrl.trim()) return;
    isPreviewing = true;
    sitemapError = '';
    sitemapUrls = [];
    selectedUrls = new Set();
    crawlResults = [];
    crawlSummary = null;

    try {
      let url = sitemapUrl.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      const res = await fetch(`/api/sitemap?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch sitemap');
      sitemapUrls = data.urls;
      // Start with all selected, then apply existing exclusion patterns
      const all = new Set<string>(data.urls.map((u: SitemapUrl) => u.loc));
      for (const su of data.urls as SitemapUrl[]) {
        if (exclusionPatterns.some((p) => matchesExclusionPattern(su.loc, p))) {
          all.delete(su.loc);
        }
      }
      selectedUrls = all;
    } catch (e) {
      sitemapError = e instanceof Error ? e.message : 'Sitemap fetch failed';
    } finally {
      isPreviewing = false;
    }
  }

  async function crawlSelected() {
    if (selectedUrls.size === 0) return;
    isCrawling = true;
    sitemapError = '';
    crawlResults = [];
    crawlSummary = null;

    try {
      const res = await fetch('/api/sitemap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: Array.from(selectedUrls) }),
      });
      if (!res.ok || !res.body) throw new Error('Failed to start crawl');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let processed = 0, unchanged = 0, failed = 0, total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === 'start') {
              total = event.total;
              crawlSummary = { total, processed: 0, unchanged: 0, failed: 0 };
            } else if (event.type === 'progress') {
              if (event.status === 'processed') processed++;
              else if (event.status === 'unchanged') unchanged++;
              else failed++;
              crawlSummary = { total, processed, unchanged, failed };
              crawlResults = [...crawlResults, event];
            } else if (event.type === 'done') {
              crawlSummary = { total: event.total, processed: event.processed, unchanged: event.unchanged, failed: event.failed };
              showToast('success', `Crawl done: ${event.processed} processed, ${event.unchanged} unchanged, ${event.failed} failed`);
              await loadDocuments();
            } else if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    } catch (e) {
      sitemapError = e instanceof Error ? e.message : 'Crawl failed';
      showToast('error', sitemapError);
    } finally {
      isCrawling = false;
    }
  }

  onMount(() => {
    loadDocuments();
  });
</script>

<svelte:head>
  <title>Crawl - RAG Lab</title>
</svelte:head>

<div class="crawl-page">
  <header class="page-header">
    <h1>Crawl & Process</h1>
    <p class="subtitle">Add URLs to process through both pipelines</p>
  </header>

  <!-- URL Input Form -->
  <section class="card">
    <h2>Process a URL</h2>
    <p class="form-hint">
      Enter a URL to fetch, extract content, and process through both Chunk and Fact pipelines.
    </p>

    <div class="input-group">
      <input
        type="text"
        class="input"
        class:error={validationError}
        bind:value={urlInput}
        oninput={() => validateUrl(urlInput)}
        onkeydown={(e) => e.key === 'Enter' && processUrl()}
        placeholder="https://docs.example.com/page"
        disabled={isProcessing}
      />
      <button
        class="btn btn-primary"
        onclick={processUrl}
        disabled={isProcessing || !urlInput.trim()}
      >
        {#if isProcessing}
          <span class="spinner-small"></span>
          Processing...
        {:else}
          Process URL
        {/if}
      </button>
    </div>

    {#if validationError}
      <p class="error-text">{validationError}</p>
    {/if}

    {#if processingStatus}
      <p class="status-text">{processingStatus}</p>
    {/if}

    {#if processingError}
      <p class="error-text">{processingError}</p>
    {/if}
  </section>

  <!-- Last Processing Result -->
  {#if lastResult}
    <section class="card result-section">
      <h2>Processing Result</h2>

      <div class="result-header">
        <div class="result-title">{lastResult.title || 'Untitled'}</div>
        <a href={lastResult.url} target="_blank" rel="noopener" class="result-url">
          {lastResult.url}
        </a>
        <div class="result-meta">
          <span class="badge badge-blue">{lastResult.wordCount} words</span>
          <span class="badge">{lastResult.processingTimeMs}ms total</span>
        </div>
      </div>

      <div class="pipeline-results">
        <div class="pipeline-result chunk">
          <h3>Chunk Pipeline</h3>
          <div class="pipeline-stats">
            <div class="stat">
              <span class="stat-value">{lastResult.chunk.chunkCount}</span>
              <span class="stat-label">Chunks</span>
            </div>
            <div class="stat">
              <span class="stat-value">{lastResult.chunk.processingTimeMs}ms</span>
              <span class="stat-label">Time</span>
            </div>
          </div>
        </div>

        <div class="pipeline-result fact">
          <h3>Fact Pipeline</h3>
          <div class="pipeline-stats">
            <div class="stat">
              <span class="stat-value">{lastResult.fact.factCount}</span>
              <span class="stat-label">Facts</span>
            </div>
            <div class="stat">
              <span class="stat-value">{lastResult.fact.processingTimeMs}ms</span>
              <span class="stat-label">Time</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  {/if}

  <!-- Sitemap Crawl -->
  <section class="card">
    <h2>Crawl Sitemap</h2>
    <p class="form-hint">
      Enter a sitemap URL to discover all pages, preview them, then crawl a selection.
    </p>

    <!-- Phase 1: Preview -->
    <div class="input-group">
      <input
        type="text"
        class="input"
        bind:value={sitemapUrl}
        onkeydown={(e) => e.key === 'Enter' && previewSitemap()}
        placeholder="https://docs.example.com/sitemap.xml"
        disabled={isPreviewing || isCrawling}
      />
      <button
        class="btn btn-primary"
        onclick={previewSitemap}
        disabled={isPreviewing || isCrawling || !sitemapUrl.trim()}
      >
        {#if isPreviewing}
          <span class="spinner-small"></span>
          Previewing...
        {:else}
          Preview
        {/if}
      </button>
    </div>

    {#if sitemapError}
      <p class="error-text">{sitemapError}</p>
    {/if}

    {#if sitemapUrls.length > 0}
      <!-- URL checklist -->
      <div class="sitemap-header">
        <span class="badge badge-blue">{sitemapUrls.length} URLs found</span>
        <button class="btn-link" onclick={toggleSelectAll}>
          {selectedUrls.size === sitemapUrls.length - excludedUrls.size ? 'Deselect all' : 'Select all'}
        </button>
        <span class="selected-count">{selectedUrls.size} selected</span>
        {#if excludedUrls.size > 0}
          <span class="badge badge-yellow">{excludedUrls.size} excluded</span>
        {/if}
      </div>

      <!-- Exclusion filters -->
      <div class="exclusion-section">
        <div class="exclusion-input-row">
          <input
            type="text"
            class="input exclusion-input"
            bind:value={exclusionInput}
            onkeydown={(e) => e.key === 'Enter' && addExclusionPattern()}
            placeholder="/projekte/* or /kontakte/*"
            disabled={isCrawling}
          />
          <button
            class="btn btn-secondary"
            onclick={addExclusionPattern}
            disabled={isCrawling || !exclusionInput.trim()}
          >
            Exclude
          </button>
        </div>
        {#if exclusionPatterns.length > 0}
          <div class="exclusion-tags">
            {#each exclusionPatterns as pattern}
              <span class="exclusion-tag">
                <code>{pattern}</code>
                <button
                  class="tag-remove"
                  onclick={() => removeExclusionPattern(pattern)}
                  aria-label="Remove exclusion {pattern}"
                >×</button>
              </span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="sitemap-list">
        {#each sitemapUrls as su}
          <label class="sitemap-item" class:excluded={excludedUrls.has(su.loc)}>
            <input
              type="checkbox"
              checked={selectedUrls.has(su.loc)}
              onchange={() => toggleUrl(su.loc)}
              disabled={isCrawling}
            />
            <span class="sitemap-loc">{su.loc}</span>
            {#if excludedUrls.has(su.loc)}
              <span class="exclusion-badge">excluded</span>
            {:else if su.lastmod}
              <span class="sitemap-meta">{su.lastmod}</span>
            {/if}
          </label>
        {/each}
      </div>

      <!-- Phase 2: Crawl -->
      <div class="crawl-action">
        <button
          class="btn btn-primary"
          onclick={crawlSelected}
          disabled={isCrawling || selectedUrls.size === 0}
        >
          {#if isCrawling}
            <span class="spinner-small"></span>
            Crawling {crawlResults.length}/{crawlSummary?.total ?? selectedUrls.size}…
          {:else}
            Crawl {selectedUrls.size} selected
          {/if}
        </button>
      </div>
    {/if}

    <!-- Crawl Results -->
    {#if crawlSummary}
      <div class="crawl-summary">
        <span class="badge badge-blue">{crawlSummary.total} total</span>
        <span class="badge badge-green">{crawlSummary.processed} processed</span>
        <span class="badge">{crawlSummary.unchanged} unchanged</span>
        {#if crawlSummary.failed > 0}
          <span class="badge badge-red">{crawlSummary.failed} failed</span>
        {/if}
      </div>

      <div class="crawl-results-table">
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>Chunks</th>
              <th>Facts</th>
              <th>LLM</th>
            </tr>
          </thead>
          <tbody>
            {#each crawlResults as r}
              <tr class="result-row-{r.status}">
                <td class="result-url-cell">
                  <a href={r.url} target="_blank" rel="noopener">{r.url}</a>
                  {#if r.error}<span class="result-error">{r.error}</span>{/if}
                </td>
                <td>
                  <span class="badge {r.status === 'processed' ? 'badge-green' : r.status === 'unchanged' ? '' : 'badge-red'}">
                    {r.status}
                  </span>
                </td>
                <td>{r.chunkCount ?? '-'}</td>
                <td>{r.factCount ?? '-'}</td>
                <td class:llm-zero={r.llmChunkCount === 0 && r.status === 'processed'}>
                  {r.llmChunkCount ?? '-'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- Recent Documents -->
  <section class="card">
    <h2>Recent Documents</h2>

    {#if loadingDocs}
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Loading documents...</span>
      </div>
    {:else if documents.length === 0}
      <div class="empty-state">
        <p>No documents processed yet.</p>
        <p class="hint">Enter a URL above to get started.</p>
      </div>
    {:else}
      <div class="documents-list">
        {#each documents as doc}
          <div class="document-item">
            <div class="doc-info">
              <div class="doc-title">{doc.title || 'Untitled'}</div>
              <a href={doc.url} target="_blank" rel="noopener" class="doc-url">{doc.url}</a>
            </div>
            <div class="doc-meta">
              <span class="badge">{doc.domain}</span>
              <span class="doc-date">{new Date(doc.updatedAt).toLocaleString()}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<!-- Toast Notifications -->
<div class="toasts" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <div class="toast {toast.type}">
      {toast.message}
    </div>
  {/each}
</div>

<style>
  .crawl-page {
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

  .form-hint {
    color: #888;
    font-size: 0.85rem;
    margin-bottom: 16px;
  }

  .input-group {
    display: flex;
    gap: 12px;
  }

  .input-group .input {
    flex: 1;
  }

  .error-text {
    color: #dc3545;
    font-size: 0.85rem;
    margin-top: 8px;
  }

  .status-text {
    color: #28a745;
    font-size: 0.85rem;
    margin-top: 8px;
  }

  .loading-state, .empty-state {
    text-align: center;
    padding: 40px;
    color: #888;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }

  .empty-state .hint {
    font-size: 0.85rem;
    margin-top: 8px;
    color: #666;
  }

  .result-section {
    border-left: 3px solid #4da3ff;
  }

  .result-header {
    margin-bottom: 20px;
  }

  .result-title {
    font-size: 1.1rem;
    font-weight: 500;
    color: #fff;
    margin-bottom: 4px;
  }

  .result-url {
    font-size: 0.85rem;
    color: #4da3ff;
    word-break: break-all;
  }

  .result-meta {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .pipeline-results {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }

  .pipeline-result {
    background: #373737;
    border-radius: 8px;
    padding: 16px;
    border-top: 3px solid #444;
  }

  .pipeline-result.chunk {
    border-top-color: #4da3ff;
  }

  .pipeline-result.fact {
    border-top-color: #28a745;
  }

  .pipeline-result h3 {
    font-size: 0.9rem;
    color: #ccc;
    margin-bottom: 12px;
  }

  .pipeline-stats {
    display: flex;
    gap: 24px;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #fff;
  }

  .stat-label {
    font-size: 0.75rem;
    color: #888;
  }

  .documents-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .document-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: #373737;
    border-radius: 6px;
  }

  .doc-info {
    flex: 1;
    min-width: 0;
  }

  .doc-title {
    font-size: 0.95rem;
    color: #fff;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .doc-url {
    font-size: 0.8rem;
    color: #4da3ff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }

  .doc-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    margin-left: 16px;
  }

  .doc-date {
    font-size: 0.75rem;
    color: #888;
  }

  /* Toast Notifications */
  .toasts {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
  }

  .toast {
    padding: 12px 20px;
    border-radius: 6px;
    color: #fff;
    font-size: 0.875rem;
    animation: slideIn 0.3s ease;
  }

  .toast.success {
    background: #28a745;
  }

  .toast.error {
    background: #dc3545;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .sitemap-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 0 8px;
    flex-wrap: wrap;
  }

  .btn-link {
    background: none;
    border: none;
    color: #4da3ff;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0;
    text-decoration: underline;
  }

  .btn-link:hover {
    color: #7bbfff;
  }

  .selected-count {
    color: #888;
    font-size: 0.8rem;
    margin-left: auto;
  }

  .sitemap-list {
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid #444;
    border-radius: 6px;
    background: #222;
    padding: 4px 0;
  }

  .sitemap-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    cursor: pointer;
    border-bottom: 1px solid #333;
  }

  .sitemap-item:last-child {
    border-bottom: none;
  }

  .sitemap-item:hover {
    background: #2d2d2d;
  }

  .sitemap-loc {
    flex: 1;
    font-size: 0.8rem;
    color: #ccc;
    word-break: break-all;
  }

  .sitemap-meta {
    font-size: 0.75rem;
    color: #666;
    flex-shrink: 0;
  }

  .exclusion-section {
    margin: 8px 0;
  }

  .exclusion-input-row {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }

  .exclusion-input {
    flex: 1;
    font-size: 0.85rem;
  }

  .exclusion-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .exclusion-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #3a2a1a;
    border: 1px solid #c0842a;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 0.8rem;
    color: #e8a84a;
  }

  .exclusion-tag code {
    font-family: monospace;
    font-size: 0.78rem;
  }

  .tag-remove {
    background: none;
    border: none;
    color: #e8a84a;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.7;
  }

  .tag-remove:hover {
    opacity: 1;
  }

  .sitemap-item.excluded {
    opacity: 0.45;
  }

  .sitemap-item.excluded .sitemap-loc {
    text-decoration: line-through;
    color: #888;
  }

  .exclusion-badge {
    font-size: 0.7rem;
    color: #c0842a;
    border: 1px solid #c0842a;
    border-radius: 3px;
    padding: 1px 4px;
    flex-shrink: 0;
  }

  .crawl-action {
    margin-top: 16px;
  }

  .crawl-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 16px 0 12px;
    flex-wrap: wrap;
  }

  .crawl-results-table {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  th {
    text-align: left;
    padding: 8px 12px;
    color: #888;
    border-bottom: 1px solid #444;
    font-weight: 500;
  }

  td {
    padding: 7px 12px;
    border-bottom: 1px solid #333;
    color: #ccc;
    vertical-align: top;
  }

  .result-url-cell a {
    color: #4da3ff;
    word-break: break-all;
    display: block;
  }

  .result-error {
    display: block;
    color: #dc3545;
    font-size: 0.75rem;
    margin-top: 2px;
  }

  .result-row-error td {
    background: #2a1a1a;
  }

  .llm-zero {
    color: #666;
  }

  @media (max-width: 768px) {
    .input-group {
      flex-direction: column;
    }

    .pipeline-results {
      grid-template-columns: 1fr;
    }

    .document-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }

    .doc-meta {
      margin-left: 0;
    }
  }
</style>
