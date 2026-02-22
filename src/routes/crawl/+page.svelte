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

  // State
  let urlInput = $state('');
  let validationError = $state('');
  let isProcessing = $state(false);
  let processingStatus = $state('');
  let processingError = $state('');
  let lastResult = $state<ProcessingResult | null>(null);

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
