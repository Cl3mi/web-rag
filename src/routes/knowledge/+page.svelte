<script lang="ts">
  import { onMount } from 'svelte';

  interface Document {
    id: string;
    url: string;
    title: string | null;
    domain: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }

  interface Chunk {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    type: 'chunk' | 'fact' | 'llm';
  }

  // State
  let documents = $state<Document[]>([]);
  let loading = $state(true);
  let error = $state('');

  // Reindex state
  let reindexing = $state(false);
  let reindexResult = $state<{ reindexed: number; failed: number; totalDocuments: number } | null>(null);
  let reindexError = $state('');

  // Filter state
  let pipelineFilter = $state<'all' | 'chunk' | 'fact' | 'llm'>('all');
  let searchQuery = $state('');
  let selectedDomain = $state<string | null>(null);

  // Expanded document state
  let expandedDocId = $state<string | null>(null);
  let chunks = $state<Chunk[]>([]);
  let loadingChunks = $state(false);

  // Get unique domains
  let domains = $derived.by(() => {
    const domainSet = new Set(documents.map((d) => d.domain));
    return [...domainSet].sort();
  });

  // Filtered documents
  let filteredDocuments = $derived.by(() => {
    let filtered = documents;

    if (selectedDomain) {
      filtered = filtered.filter((d) => d.domain === selectedDomain);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.title?.toLowerCase().includes(query) ||
          d.url.toLowerCase().includes(query) ||
          d.domain.toLowerCase().includes(query)
      );
    }

    return filtered;
  });

  async function loadDocuments() {
    loading = true;
    error = '';

    try {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error('Failed to load documents');

      const data = await res.json();
      documents = data.recentDocuments || [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load documents';
    } finally {
      loading = false;
    }
  }

  async function loadChunks(documentId: string) {
    loadingChunks = true;
    chunks = [];

    try {
      // Fetch all stored items for this document directly (bypasses vector search)
      const [chunkRes, factRes, llmRes] = await Promise.all([
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId, pipeline: 'chunk' }),
        }),
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId, pipeline: 'fact' }),
        }),
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId, pipeline: 'llm' }),
        }),
      ]);

      const chunkData = chunkRes.ok ? await chunkRes.json() : { results: [] };
      const factData = factRes.ok ? await factRes.json() : { results: [] };
      const llmData = llmRes.ok ? await llmRes.json() : { results: [] };

      const chunkItems = (chunkData.results || []).map((r: any) => ({ ...r, type: 'chunk' as const }));
      const factItems = (factData.results || []).map((r: any) => ({ ...r, type: 'fact' as const }));
      const llmItems = (llmData.results || []).map((r: any) => ({ ...r, type: 'llm' as const }));

      chunks = [...chunkItems, ...factItems, ...llmItems];
    } catch (e) {
      console.error('Failed to load chunks:', e);
    } finally {
      loadingChunks = false;
    }
  }

  async function reindexAll() {
    if (!confirm(`Re-process all ${documents.length} documents with the current chunking config? This will delete and recreate all chunks/facts/summaries. The LLM pipeline may take several minutes.`)) {
      return;
    }

    reindexing = true;
    reindexResult = null;
    reindexError = '';
    // Close any expanded doc to avoid stale data
    expandedDocId = null;
    chunks = [];

    try {
      const res = await fetch('/api/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reindex failed');
      reindexResult = data;
    } catch (e) {
      reindexError = e instanceof Error ? e.message : 'Reindex failed';
    } finally {
      reindexing = false;
    }
  }

  function toggleExpand(docId: string) {
    if (expandedDocId === docId) {
      expandedDocId = null;
      chunks = [];
    } else {
      expandedDocId = docId;
      loadChunks(docId);
    }
  }

  let deletingDocId = $state<string | null>(null);

  async function deleteDocument(docId: string, event: Event) {
    event.stopPropagation();

    if (!confirm('Are you sure you want to delete this document and all its chunks/facts/summaries?')) {
      return;
    }

    deletingDocId = docId;

    try {
      const res = await fetch('/api/scrape', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete document');
      }

      // Remove from local state
      documents = documents.filter((d) => d.id !== docId);

      if (expandedDocId === docId) {
        expandedDocId = null;
        chunks = [];
      }
    } catch (e) {
      console.error('Failed to delete document:', e);
      alert(e instanceof Error ? e.message : 'Failed to delete document');
    } finally {
      deletingDocId = null;
    }
  }

  // Filtered chunks based on pipeline filter
  let filteredChunks = $derived.by(() => {
    if (pipelineFilter === 'all') return chunks;
    return chunks.filter((c) => c.type === pipelineFilter);
  });

  onMount(() => {
    loadDocuments();
  });
</script>

<svelte:head>
  <title>Knowledge - RAG Lab</title>
</svelte:head>

<div class="knowledge-page">
  <header class="page-header">
    <div class="header-row">
      <div>
        <h1>Knowledge Base</h1>
        <p class="subtitle">Browse documents and their chunks/facts/summaries</p>
      </div>
      <button
        class="btn btn-secondary reindex-btn"
        onclick={reindexAll}
        disabled={reindexing || loading}
        title="Re-chunk and re-embed all documents using the current config (no web fetch)"
      >
        {#if reindexing}
          <span class="spinner-small"></span> Reindexing…
        {:else}
          ↺ Reindex All
        {/if}
      </button>
    </div>

    {#if reindexResult}
      <div class="reindex-result success">
        Reindexed {reindexResult.reindexed}/{reindexResult.totalDocuments} documents
        {#if reindexResult.failed > 0}— {reindexResult.failed} failed{/if}
      </div>
    {/if}
    {#if reindexError}
      <div class="reindex-result error">{reindexError}</div>
    {/if}
  </header>

  <!-- Filters -->
  <section class="filters-bar">
    <input
      type="text"
      class="input search-input"
      placeholder="Search documents..."
      bind:value={searchQuery}
    />

    <select class="input select" bind:value={selectedDomain}>
      <option value={null}>All Domains</option>
      {#each domains as domain}
        <option value={domain}>{domain}</option>
      {/each}
    </select>

    <div class="pipeline-toggle">
      <button
        class="toggle-btn"
        class:active={pipelineFilter === 'all'}
        onclick={() => (pipelineFilter = 'all')}
      >
        All
      </button>
      <button
        class="toggle-btn chunk"
        class:active={pipelineFilter === 'chunk'}
        onclick={() => (pipelineFilter = 'chunk')}
      >
        Chunk
      </button>
      <button
        class="toggle-btn fact"
        class:active={pipelineFilter === 'fact'}
        onclick={() => (pipelineFilter = 'fact')}
      >
        Fact
      </button>
      <button
        class="toggle-btn llm"
        class:active={pipelineFilter === 'llm'}
        onclick={() => (pipelineFilter = 'llm')}
      >
        Summaries
      </button>
    </div>
  </section>

  <!-- Documents List -->
  <section class="documents-section">
    {#if loading}
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Loading documents...</span>
      </div>
    {:else if error}
      <div class="error-state">
        <p>{error}</p>
        <button class="btn btn-secondary" onclick={loadDocuments}>Retry</button>
      </div>
    {:else if filteredDocuments.length === 0}
      <div class="empty-state">
        <p>No documents found.</p>
        {#if searchQuery || selectedDomain}
          <p class="hint">Try adjusting your filters.</p>
        {:else}
          <p class="hint">
            <a href="/crawl">Add some documents</a> to get started.
          </p>
        {/if}
      </div>
    {:else}
      <div class="documents-list">
        {#each filteredDocuments as doc}
          <div class="document-card" class:expanded={expandedDocId === doc.id}>
            <button class="document-header" onclick={() => toggleExpand(doc.id)}>
              <div class="doc-info">
                <div class="doc-title">{doc.title || 'Untitled'}</div>
                <div class="doc-url">{doc.url}</div>
              </div>
              <div class="doc-meta">
                <span class="badge">{doc.domain}</span>
              </div>
              <span
                class="btn-delete"
                class:disabled={deletingDocId === doc.id}
                onclick={(e) => { if (deletingDocId !== doc.id) deleteDocument(doc.id, e); }}
                onkeydown={(e) => e.key === 'Enter' && deletingDocId !== doc.id && deleteDocument(doc.id, e)}
                role="button"
                tabindex="0"
                title="Delete document"
              >
                {#if deletingDocId === doc.id}
                  <span class="spinner-small"></span>
                {:else}
                  ×
                {/if}
              </span>
              <span class="expand-icon">{expandedDocId === doc.id ? '−' : '+'}</span>
            </button>

            {#if expandedDocId === doc.id}
              <div class="chunks-section">
                {#if loadingChunks}
                  <div class="loading-state">
                    <div class="spinner"></div>
                  </div>
                {:else if filteredChunks.length === 0}
                  <p class="no-chunks">No chunks found for this filter.</p>
                {:else}
                  <div class="chunks-list">
                    {#each filteredChunks as chunk}
                      <div class="chunk-card {chunk.type}">
                        <div class="chunk-header">
                          <span class="badge 
                            {chunk.type === 'chunk' ? 'badge-blue' : chunk.type === 'fact' ? 'badge-green' : 'badge-purple'}">
                            {chunk.type === 'chunk' 
                            ? 'Chunk' 
                            : chunk.type === 'fact' 
                            ? 'Fact' 
                            : 'Summary'}
                          </span>
                          {#if chunk.metadata?.category}
                            <span class="badge badge-purple">{chunk.metadata.category}</span>
                          {/if}
                          {#if chunk.metadata?.confidence}
                            <span class="confidence">{(chunk.metadata.confidence as number * 100).toFixed(0)}% confidence</span>
                          {/if}
                        </div>
                        <div class="chunk-content">{chunk.content}</div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .knowledge-page {
    padding: 24px;
    max-width: 90vw;
  }

  .page-header {
    margin-bottom: 24px;
  }

  .header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .reindex-btn {
    flex-shrink: 0;
    align-self: center;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .reindex-result {
    margin-top: 10px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .reindex-result.success {
    background: rgba(40, 167, 69, 0.15);
    color: #28a745;
    border: 1px solid rgba(40, 167, 69, 0.3);
  }

  .reindex-result.error {
    background: rgba(220, 53, 69, 0.15);
    color: #dc3545;
    border: 1px solid rgba(220, 53, 69, 0.3);
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

  .filters-bar {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }

  .search-input {
    flex: 1;
    min-width: 200px;
  }

  .select {
    min-width: 150px;
  }

  .pipeline-toggle {
    display: flex;
    background: #2d2d2d;
    border-radius: 6px;
    overflow: hidden;
  }

  .toggle-btn {
    padding: 10px 16px;
    background: transparent;
    border: none;
    color: #888;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .toggle-btn:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.05);
  }

  .toggle-btn.active {
    color: #fff;
    background: #444;
  }

  .toggle-btn.chunk.active {
    background: rgba(77, 163, 255, 0.3);
    color: #4da3ff;
  }

  .toggle-btn.fact.active {
    background: rgba(40, 167, 69, 0.3);
    color: #28a745;
  }

  .toggle-btn.llm.active {
    background: rgba(111, 66, 193, 0.2);
    color: #6f42c1;
  }

  .loading-state, .error-state, .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px;
    gap: 16px;
    color: #888;
    background: #2d2d2d;
    border-radius: 8px;
  }

  .loading-state {
    flex-direction: row;
  }

  .empty-state .hint {
    font-size: 0.85rem;
    color: #666;
  }

  .documents-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .document-card {
    background: #2d2d2d;
    border-radius: 8px;
    overflow: hidden;
  }

  .document-card.expanded {
    border: 1px solid #4da3ff;
  }

  .document-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px;
    background: transparent;
    border: none;
    color: #fff;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .document-header:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .doc-info {
    flex: 1;
    min-width: 0;
  }

  .doc-title {
    font-weight: 500;
    margin-bottom: 2px;
  }

  .doc-url {
    font-size: 0.8rem;
    color: #4da3ff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .doc-meta {
    flex-shrink: 0;
  }

  .expand-icon {
    font-size: 1.25rem;
    color: #888;
    flex-shrink: 0;
  }

  .btn-delete {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid #666;
    border-radius: 4px;
    color: #888;
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .btn-delete:hover:not(.disabled) {
    color: #dc3545;
    border-color: #dc3545;
    background: rgba(220, 53, 69, 0.1);
  }

  .btn-delete.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .spinner-small {
    width: 12px;
    height: 12px;
    border: 2px solid #444;
    border-top-color: #888;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    display: inline-block;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .chunks-section {
    border-top: 1px solid #444;
    padding: 16px;
    max-height: 500px;
    overflow-y: auto;
  }

  .no-chunks {
    text-align: center;
    color: #888;
    padding: 20px;
  }

  .chunks-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .chunk-card {
    padding: 12px;
    background: #373737;
    border-radius: 6px;
    border-left: 3px solid #444;
  }

  .chunk-card.chunk {
    border-left-color: #4da3ff;
  }

  .chunk-card.fact {
    border-left-color: #28a745;
  }

  .chunk-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .confidence {
    font-size: 0.75rem;
    color: #888;
  }

  .chunk-content {
    font-size: 0.85rem;
    color: #ccc;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  @media (max-width: 768px) {
    .filters-bar {
      flex-direction: column;
    }

    .search-input, .select {
      width: 100%;
    }

    .pipeline-toggle {
      width: 100%;
      justify-content: stretch;
    }

    .toggle-btn {
      flex: 1;
    }
  }
</style>
