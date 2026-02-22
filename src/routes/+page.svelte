<script lang="ts">
  import { onMount } from 'svelte';

  interface Metrics {
    overview: {
      totalDocuments: number;
      totalChunks: number;
      totalFacts: number;
      totalLLMChunks: number;
      avgChunksPerDoc: number;
      avgFactsPerDoc: number;
      avgLLMPerDoc: number;
    };
    domains: Array<{
      domain: string;
      documentCount: number;
      lastUpdated: string;
    }>;
    factCategories: Record<string, number>;
    recentDocuments: Array<{
      id: string;
      url: string;
      title: string | null;
      domain: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }

  interface PipelineEvalMetrics {
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
  }

  interface OverlapMetrics {
    avgChunkFact: number;
    avgChunkLlm: number;
    avgFactLlm: number;
  }

  interface LatestEvaluation {
    run: {
      id: string;
      name: string | null;
      metrics: {
        chunk?: PipelineEvalMetrics;
        fact?: PipelineEvalMetrics;
        llm?: PipelineEvalMetrics;
        overlap?: OverlapMetrics;
      };
    } | null;
  }

  interface SearchResult {
    id: string;
    content: string;
    score: number;
    sourceUrl?: string;
    sourceTitle?: string;
  }

  interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    sources?: Array<{ title: string | null; url: string | null; content: string }>;
    pipeline?: string;
    model?: string;
    latencyMs?: number;
  }

  // State
  let metrics = $state<Metrics | null>(null);
  let latestEval = $state<LatestEvaluation | null>(null);
  let loading = $state(true);
  let error = $state('');

  // Chat state
  let chatInput = $state('');
  let chatPipeline = $state<'chunk' | 'fact' | 'llm'>('chunk');
  let chatModel = $state('llama3.2');
  let availableModels = $state<string[]>([]);
  let chatMessages = $state<ChatMessage[]>([]);
  let chatLoading = $state(false);
  let chatError = $state('');

  // Quick search state
  let searchQuery = $state('');
  let searchPipeline = $state<'chunk' | 'fact' | 'llm'>('chunk');
  let searching = $state(false);
  let searchResults = $state<{ chunk: SearchResult[]; fact: SearchResult[]; llm: SearchResult[] }>({
    chunk: [],
    fact: [],
    llm: [],
  });

  async function loadData() {
    loading = true;
    error = '';

    try {
      const [metricsRes, evalRes, modelsRes] = await Promise.all([
        fetch('/api/metrics'),
        fetch('/api/evaluate/latest'),
        fetch('/api/chat'),
      ]);

      if (metricsRes.ok) {
        metrics = await metricsRes.json();
      }

      if (evalRes.ok) {
        latestEval = await evalRes.json();
      }

      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        availableModels = modelsData.models || [];
        if (modelsData.defaultModel && availableModels.includes(modelsData.defaultModel)) {
          chatModel = modelsData.defaultModel;
        } else if (availableModels.length > 0) {
          chatModel = availableModels[0];
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data';
    } finally {
      loading = false;
    }
  }

  async function sendChatMessage() {
    if (!chatInput.trim() || chatLoading) return;

    const userMessage = chatInput.trim();
    chatInput = '';
    chatError = '';

    // Add user message
    chatMessages = [...chatMessages, { role: 'user', content: userMessage }];
    chatLoading = true;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          pipeline: chatPipeline,
          model: chatModel,
          topK: 5,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Chat request failed');
      }

      // Add assistant message
      chatMessages = [
        ...chatMessages,
        {
          role: 'assistant',
          content: data.response,
          sources: data.sources,
          pipeline: data.pipeline,
          model: data.model,
          latencyMs: data.latencyMs,
        },
      ];
    } catch (e) {
      chatError = e instanceof Error ? e.message : 'Chat failed';
      // Remove the user message if there was an error
      chatMessages = chatMessages.slice(0, -1);
    } finally {
      chatLoading = false;
    }
  }

  function clearChat() {
    chatMessages = [];
    chatError = '';
  }

  async function search() {
    if (!searchQuery.trim()) return;

  console.log(searchQuery);
    searching = true;

    try {
      // Search all three pipelines in parallel
      const [chunkRes, factRes, llmRes] = await Promise.all([
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery, pipeline: 'chunk', topK: 5 }),
        }),
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery, pipeline: 'fact', topK: 5 }),
        }),
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery, pipeline: 'llm', topK: 5 }),
        }),
      ]);

      if (chunkRes.ok) {
        const data = await chunkRes.json();
        searchResults.chunk = data.results || [];
      }

      if (factRes.ok) {
        const data = await factRes.json();
        searchResults.fact = data.results || [];
      }

      if (llmRes.ok) {
        const data = await llmRes.json();
        searchResults.llm = data.results || [];
      }
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      searching = false;
    }
  }

  function formatNumber(n: number): string {
    return n.toLocaleString();
  }

  function formatPercent(n: number): string {
    return (n * 100).toFixed(1) + '%';
  }

  onMount(() => {
    loadData();
  });
</script>

<svelte:head>
  <title>Dashboard - RAG Lab</title>
</svelte:head>

<div class="dashboard">
  <header class="page-header">
    <h1>Dashboard</h1>
    <p class="subtitle">RAG Pipeline Comparison System</p>
  </header>

  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Loading metrics...</span>
    </div>
  {:else if error}
    <div class="error-state">
      <p>{error}</p>
      <button class="btn btn-secondary" onclick={loadData}>Retry</button>
    </div>
  {:else}
    <!-- Stats Cards -->
    <section class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">📄</div>
        <div class="stat-content">
          <div class="stat-value">{formatNumber(metrics?.overview?.totalDocuments ?? 0)}</div>
          <div class="stat-label">Documents</div>
        </div>
      </div>

      <div class="stat-card chunk">
        <div class="stat-icon">📦</div>
        <div class="stat-content">
          <div class="stat-value">{formatNumber(metrics?.overview?.totalChunks ?? 0)}</div>
          <div class="stat-label">Chunks</div>
          <div class="stat-sub">~{(metrics?.overview?.avgChunksPerDoc ?? 0).toFixed(1)} per doc</div>
        </div>
      </div>

      <div class="stat-card fact">
        <div class="stat-icon">💡</div>
        <div class="stat-content">
          <div class="stat-value">{formatNumber(metrics?.overview?.totalFacts ?? 0)}</div>
          <div class="stat-label">Facts</div>
          <div class="stat-sub">~{(metrics?.overview?.avgFactsPerDoc ?? 0).toFixed(1)} per doc</div>
        </div>
      </div>

      <div class="stat-card llm">
        <div class="stat-icon">🤖</div>
        <div class="stat-content">
          <div class="stat-value">{formatNumber(metrics?.overview?.totalLLMChunks ?? 0)}</div>
          <div class="stat-label">LLM Chunks</div>
          <div class="stat-sub">~{(metrics?.overview?.avgLLMPerDoc ?? 0).toFixed(1)} per doc</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">🌐</div>
        <div class="stat-content">
          <div class="stat-value">{metrics?.domains?.length ?? 0}</div>
          <div class="stat-label">Domains</div>
        </div>
      </div>
    </section>

    <!-- Chat Interface -->
    <section class="card chat-section">
      <div class="chat-header">
        <h2>Chat with Knowledge Base</h2>
        <div class="chat-controls">
          <div class="control-group">
            <label class="control-label">Pipeline</label>
            <div class="pipeline-toggle">
              <button
                class="toggle-btn"
                class:active={chatPipeline === 'chunk'}
                onclick={() => (chatPipeline = 'chunk')}
              >
                Chunk
              </button>
              <button
                class="toggle-btn"
                class:active={chatPipeline === 'fact'}
                onclick={() => (chatPipeline = 'fact')}
              >
                Fact
              </button>
              <button
                class="toggle-btn"
                class:active={chatPipeline === 'llm'}
                onclick={() => (chatPipeline = 'llm')}
              >
                LLM
              </button>
            </div>
          </div>
          <div class="control-group">
            <label class="control-label">Model</label>
            {#if availableModels.length > 0}
              <select class="input model-select" bind:value={chatModel}>
                {#each availableModels as model}
                  <option value={model}>{model}</option>
                {/each}
              </select>
            {:else}
              <span class="no-models">No Ollama models found</span>
            {/if}
          </div>
          {#if chatMessages.length > 0}
            <button class="btn btn-secondary btn-sm" onclick={clearChat}>Clear</button>
          {/if}
        </div>
      </div>

      <div class="chat-messages">
        {#if chatMessages.length === 0}
          <div class="chat-empty">
            <p>Ask a question about your indexed documents.</p>
            <p class="hint">The answer will be generated using the {chatPipeline === 'chunk' ? 'Chunk' : chatPipeline === 'fact' ? 'Fact' : 'LLM'} pipeline and {chatModel}.</p>
          </div>
        {:else}
          {#each chatMessages as message}
            <div class="chat-message {message.role}">
              <div class="message-header">
                <span class="message-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
                {#if message.role === 'assistant' && message.latencyMs}
                  <span class="message-meta">
                    {message.pipeline} · {message.model} · {message.latencyMs}ms
                  </span>
                {/if}
              </div>
              <div class="message-content">{message.content}</div>
              {#if message.sources && message.sources.length > 0}
                <div class="message-sources">
                  <div class="sources-header">Sources:</div>
                  {#each message.sources as source, i}
                    <div class="source-item">
                      <span class="source-num">[{i + 1}]</span>
                      {#if source.title}
                        <span class="source-title">{source.title}</span>
                      {:else if source.url}
                        <span class="source-url">{source.url}</span>
                      {/if}
                      <div class="source-preview">{source.content}</div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
          {#if chatLoading}
            <div class="chat-message assistant loading">
              <div class="message-header">
                <span class="message-role">Assistant</span>
              </div>
              <div class="message-content">
                <span class="typing-indicator">
                  <span></span><span></span><span></span>
                </span>
              </div>
            </div>
          {/if}
        {/if}
      </div>

      {#if chatError}
        <div class="chat-error">{chatError}</div>
      {/if}

      <div class="chat-input-container">
        <input
          type="text"
          class="input chat-input"
          placeholder="Ask a question..."
          bind:value={chatInput}
          onkeydown={(e) => e.key === 'Enter' && sendChatMessage()}
          disabled={chatLoading || availableModels.length === 0}
        />
        <button
          class="btn btn-primary"
          onclick={sendChatMessage}
          disabled={chatLoading || !chatInput.trim() || availableModels.length === 0}
        >
          {#if chatLoading}
            <span class="spinner-small"></span>
          {:else}
            Send
          {/if}
        </button>
      </div>

      {#if availableModels.length === 0}
        <p class="ollama-hint">
          Make sure Ollama is running locally. Install from <a href="https://ollama.ai" target="_blank" rel="noopener">ollama.ai</a> and run a model like <code>ollama run llama3.2</code>.
        </p>
      {/if}
    </section>

    <!-- Latest Evaluation Comparison -->
    {#if latestEval?.run?.metrics}
      <section class="card evaluation-section">
        <h2>Latest Evaluation Results</h2>
        <div class="eval-comparison three-col">
          {#if latestEval.run.metrics.chunk}
            <div class="eval-card chunk">
              <h3>Chunk Pipeline</h3>
              <div class="eval-metrics">
                <div class="eval-metric">
                  <span class="metric-label">Recall@5</span>
                  <span class="metric-value">{formatPercent(latestEval.run.metrics.chunk.recallAt5 ?? 0)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">MRR</span>
                  <span class="metric-value">{(latestEval.run.metrics.chunk.mrr ?? 0).toFixed(3)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">Hit@5</span>
                  <span class="metric-value">{formatPercent(latestEval.run.metrics.chunk.hitAt5 ?? 0)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">Latency</span>
                  <span class="metric-value">{(latestEval.run.metrics.chunk.avgLatencyMs ?? 0).toFixed(0)}ms</span>
                </div>
              </div>
            </div>
          {/if}

          {#if latestEval.run.metrics.fact}
            <div class="eval-card fact">
              <h3>Fact Pipeline</h3>
              <div class="eval-metrics">
                <div class="eval-metric">
                  <span class="metric-label">Recall@5</span>
                  <span class="metric-value">{formatPercent(latestEval.run.metrics.fact.recallAt5 ?? 0)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">MRR</span>
                  <span class="metric-value">{(latestEval.run.metrics.fact.mrr ?? 0).toFixed(3)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">Hit@5</span>
                  <span class="metric-value">{formatPercent(latestEval.run.metrics.fact.hitAt5 ?? 0)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">Latency</span>
                  <span class="metric-value">{(latestEval.run.metrics.fact.avgLatencyMs ?? 0).toFixed(0)}ms</span>
                </div>
              </div>
            </div>
          {/if}

          {#if latestEval.run.metrics.llm}
            <div class="eval-card llm">
              <h3>LLM Pipeline</h3>
              <div class="eval-metrics">
                <div class="eval-metric">
                  <span class="metric-label">Recall@5</span>
                  <span class="metric-value">{formatPercent(latestEval.run.metrics.llm.recallAt5 ?? 0)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">MRR</span>
                  <span class="metric-value">{(latestEval.run.metrics.llm.mrr ?? 0).toFixed(3)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">Hit@5</span>
                  <span class="metric-value">{formatPercent(latestEval.run.metrics.llm.hitAt5 ?? 0)}</span>
                </div>
                <div class="eval-metric">
                  <span class="metric-label">Latency</span>
                  <span class="metric-value">{(latestEval.run.metrics.llm.avgLatencyMs ?? 0).toFixed(0)}ms</span>
                </div>
              </div>
            </div>
          {/if}
        </div>

        {#if latestEval.run.metrics.overlap}
          <div class="overlap-section">
            <h4>Pipeline Overlap (Jaccard)</h4>
            <div class="overlap-metrics">
              <div class="overlap-item">
                <span class="overlap-label">Chunk ↔ Fact</span>
                <span class="overlap-value">{formatPercent(latestEval.run.metrics.overlap.avgChunkFact ?? 0)}</span>
              </div>
              <div class="overlap-item">
                <span class="overlap-label">Chunk ↔ LLM</span>
                <span class="overlap-value">{formatPercent(latestEval.run.metrics.overlap.avgChunkLlm ?? 0)}</span>
              </div>
              <div class="overlap-item">
                <span class="overlap-label">Fact ↔ LLM</span>
                <span class="overlap-value">{formatPercent(latestEval.run.metrics.overlap.avgFactLlm ?? 0)}</span>
              </div>
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <!-- Quick Search Test -->
    <section class="card search-section">
      <h2>Quick Search Test</h2>
      <p class="section-desc">Test both pipelines side-by-side</p>

      <div class="search-form">
        <input
          type="text"
          class="input search-input"
          placeholder="Enter a search query..."
          bind:value={searchQuery}
          onkeydown={(e) => e.key === 'Enter' && search()}
        />
        <button class="btn btn-primary" onclick={search} disabled={searching || !searchQuery.trim()}>
          {#if searching}
            <span class="spinner-small"></span>
            Searching...
          {:else}
            Search
          {/if}
        </button>
      </div>

      {#if searchResults.chunk.length > 0 || searchResults.fact.length > 0 || searchResults.llm.length > 0}
        <div class="search-results three-col">
          <div class="results-column chunk">
            <h4>Chunk Pipeline</h4>
            {#each searchResults.chunk as result}
              <div class="result-item">
                <div class="result-score badge badge-blue">{(result.score ?? 0).toFixed(3)}</div>
                <div class="result-content">{(result.content ?? '').slice(0, 150)}...</div>
                {#if result.sourceTitle}
                  <div class="result-source">{result.sourceTitle}</div>
                {/if}
              </div>
            {:else}
              <p class="no-results">No results</p>
            {/each}
          </div>

          <div class="results-column fact">
            <h4>Fact Pipeline</h4>
            {#each searchResults.fact as result}
              <div class="result-item">
                <div class="result-score badge badge-green">{(result.score ?? 0).toFixed(3)}</div>
                <div class="result-content">{(result.content ?? '').slice(0, 150)}...</div>
                {#if result.sourceTitle}
                  <div class="result-source">{result.sourceTitle}</div>
                {/if}
              </div>
            {:else}
              <p class="no-results">No results</p>
            {/each}
          </div>

          <div class="results-column llm">
            <h4>LLM Pipeline</h4>
            {#each searchResults.llm as result}
              <div class="result-item">
                <div class="result-score badge badge-purple">{(result.score ?? 0).toFixed(3)}</div>
                <div class="result-content">{(result.content ?? '').slice(0, 150)}...</div>
                {#if result.sourceTitle}
                  <div class="result-source">{result.sourceTitle}</div>
                {/if}
              </div>
            {:else}
              <p class="no-results">No results</p>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <!-- Recent Documents -->
    {#if metrics && metrics.recentDocuments && metrics.recentDocuments.length > 0}
      <section class="card">
        <h2>Recent Documents</h2>
        <div class="recent-docs">
          {#each metrics.recentDocuments as doc}
            <div class="doc-item">
              <div class="doc-title">{doc.title || 'Untitled'}</div>
              <div class="doc-meta">
                <span class="doc-domain">{doc.domain}</span>
                <span class="doc-date">{doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString() : 'N/A'}</span>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .dashboard {
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

  .loading-state, .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px;
    gap: 16px;
    color: #888;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: #2d2d2d;
    border-radius: 8px;
    padding: 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-left: 3px solid #444;
  }

  .stat-card.chunk {
    border-left-color: #4da3ff;
  }

  .stat-card.fact {
    border-left-color: #28a745;
  }

  .stat-card.llm {
    border-left-color: #9b59b6;
  }

  .stat-icon {
    font-size: 2rem;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: #fff;
  }

  .stat-label {
    color: #888;
    font-size: 0.85rem;
  }

  .stat-sub {
    color: #666;
    font-size: 0.75rem;
    margin-top: 2px;
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

  .section-desc {
    color: #888;
    font-size: 0.85rem;
    margin-bottom: 16px;
    margin-top: -8px;
  }

  .evaluation-section .eval-comparison {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
  }

  .evaluation-section .eval-comparison.three-col {
    grid-template-columns: repeat(3, 1fr);
  }

  .eval-card {
    background: #373737;
    border-radius: 8px;
    padding: 16px;
    border-top: 3px solid #444;
  }

  .eval-card.chunk {
    border-top-color: #4da3ff;
  }

  .eval-card.fact {
    border-top-color: #28a745;
  }

  .eval-card.llm {
    border-top-color: #9b59b6;
  }

  .overlap-section {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid #444;
  }

  .overlap-section h4 {
    font-size: 0.9rem;
    color: #888;
    margin-bottom: 12px;
  }

  .overlap-metrics {
    display: flex;
    gap: 24px;
  }

  .overlap-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .overlap-label {
    font-size: 0.85rem;
    color: #888;
  }

  .overlap-value {
    font-size: 0.95rem;
    font-weight: 600;
    color: #fff;
  }

  .eval-card h3 {
    font-size: 0.95rem;
    color: #ccc;
    margin-bottom: 12px;
  }

  .eval-metrics {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .eval-metric {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .metric-label {
    font-size: 0.75rem;
    color: #888;
  }

  .metric-value {
    font-size: 1.1rem;
    font-weight: 600;
    color: #fff;
  }

  .search-form {
    display: flex;
    gap: 12px;
    margin-bottom: 20px;
  }

  .search-input {
    flex: 1;
  }

  .search-results {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
  }

  .search-results.three-col {
    grid-template-columns: repeat(3, 1fr);
  }

  .results-column {
    background: #373737;
    border-radius: 8px;
    padding: 16px;
    border-top: 3px solid #444;
  }

  .results-column.chunk {
    border-top-color: #4da3ff;
  }

  .results-column.fact {
    border-top-color: #28a745;
  }

  .results-column.llm {
    border-top-color: #9b59b6;
  }

  .badge-purple {
    background: #9b59b6;
    color: #fff;
  }

  .results-column h4 {
    font-size: 0.9rem;
    color: #ccc;
    margin-bottom: 12px;
  }

  .result-item {
    padding: 12px;
    background: #2d2d2d;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .result-score {
    margin-bottom: 8px;
  }

  .result-content {
    font-size: 0.85rem;
    color: #ccc;
    line-height: 1.5;
  }

  .result-source {
    font-size: 0.75rem;
    color: #888;
    margin-top: 8px;
  }

  .no-results {
    color: #666;
    font-size: 0.85rem;
    text-align: center;
    padding: 20px;
  }

  .recent-docs {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .doc-item {
    padding: 12px;
    background: #373737;
    border-radius: 6px;
  }

  .doc-title {
    font-size: 0.9rem;
    color: #fff;
    margin-bottom: 4px;
  }

  .doc-meta {
    display: flex;
    gap: 12px;
    font-size: 0.75rem;
    color: #888;
  }

  /* Chat Interface Styles */
  .chat-section {
    border: 1px solid #444;
  }

  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 16px;
  }

  .chat-header h2 {
    margin-bottom: 0;
  }

  .chat-controls {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    flex-wrap: wrap;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .control-label {
    font-size: 0.75rem;
    color: #888;
  }

  .pipeline-toggle {
    display: flex;
    background: #373737;
    border-radius: 6px;
    overflow: hidden;
  }

  .toggle-btn {
    padding: 8px 16px;
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
    background: #4da3ff;
  }

  .model-select {
    min-width: 150px;
    padding: 8px 12px;
    font-size: 0.85rem;
  }

  .no-models {
    font-size: 0.85rem;
    color: #888;
    padding: 8px;
  }

  .btn-sm {
    padding: 8px 12px;
    font-size: 0.85rem;
  }

  .chat-messages {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 16px;
    min-height: 200px;
    max-height: 400px;
    overflow-y: auto;
    margin-bottom: 16px;
  }

  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 150px;
    color: #888;
    text-align: center;
  }

  .chat-empty .hint {
    font-size: 0.85rem;
    color: #666;
    margin-top: 8px;
  }

  .chat-message {
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 12px;
  }

  .chat-message.user {
    background: #2d4a6d;
    margin-left: 40px;
  }

  .chat-message.assistant {
    background: #373737;
    margin-right: 40px;
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .message-role {
    font-size: 0.75rem;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
  }

  .message-meta {
    font-size: 0.7rem;
    color: #666;
  }

  .message-content {
    font-size: 0.9rem;
    color: #fff;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .message-sources {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #444;
  }

  .sources-header {
    font-size: 0.75rem;
    font-weight: 600;
    color: #888;
    margin-bottom: 8px;
  }

  .source-item {
    padding: 8px;
    background: #2d2d2d;
    border-radius: 4px;
    margin-bottom: 6px;
  }

  .source-num {
    font-size: 0.75rem;
    color: #4da3ff;
    font-weight: 600;
    margin-right: 6px;
  }

  .source-title {
    font-size: 0.8rem;
    color: #fff;
  }

  .source-url {
    font-size: 0.75rem;
    color: #4da3ff;
    word-break: break-all;
  }

  .source-preview {
    font-size: 0.75rem;
    color: #888;
    margin-top: 4px;
    line-height: 1.4;
  }

  .typing-indicator {
    display: flex;
    gap: 4px;
  }

  .typing-indicator span {
    width: 8px;
    height: 8px;
    background: #888;
    border-radius: 50%;
    animation: typing 1.4s infinite ease-in-out;
  }

  .typing-indicator span:nth-child(1) {
    animation-delay: 0s;
  }

  .typing-indicator span:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing-indicator span:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typing {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    30% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }

  .chat-error {
    background: rgba(220, 53, 69, 0.2);
    border: 1px solid #dc3545;
    border-radius: 6px;
    padding: 12px;
    color: #dc3545;
    font-size: 0.85rem;
    margin-bottom: 16px;
  }

  .chat-input-container {
    display: flex;
    gap: 12px;
  }

  .chat-input {
    flex: 1;
  }

  .ollama-hint {
    font-size: 0.8rem;
    color: #888;
    margin-top: 12px;
    text-align: center;
  }

  .ollama-hint a {
    color: #4da3ff;
  }

  .ollama-hint code {
    background: #373737;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  @media (max-width: 1200px) {
    .stats-grid {
      grid-template-columns: repeat(3, 1fr);
    }

    .evaluation-section .eval-comparison.three-col,
    .search-results.three-col {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 1024px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }

    .evaluation-section .eval-comparison,
    .evaluation-section .eval-comparison.three-col,
    .search-results,
    .search-results.three-col {
      grid-template-columns: 1fr;
    }

    .overlap-metrics {
      flex-direction: column;
      gap: 8px;
    }

    .search-form {
      flex-direction: column;
    }

    .chat-header {
      flex-direction: column;
    }

    .chat-controls {
      width: 100%;
      justify-content: space-between;
    }

    .chat-message.user {
      margin-left: 20px;
    }

    .chat-message.assistant {
      margin-right: 20px;
    }

    .chat-input-container {
      flex-direction: column;
    }
  }
</style>
