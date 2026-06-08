<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  interface ConversationItem {
    id: string;
    sessionId: string | null;
    question: string;
    answer: string;
    pipeline: string;
    model: string;
    latencyMs: number;
    rating: 'up' | 'down' | null;
    ratingCategory: string | null;
    ratingFreetext: string | null;
    ratingCreatedAt: string | null;
    reviewedAt: string | null;
    trainingWeight: number | null;
    createdAt: string;
  }

  interface ConversationDetail extends ConversationItem {
    context: string[];
    sources: Array<{ title: string | null; url: string | null; content: string }>;
  }

  const RATING_CATEGORIES: Record<string, string> = {
    hallucination: 'Hallucination',
    incomplete:    'Incomplete',
    irrelevant:    'Irrelevant',
    misleading:    'Misleading',
    off_topic:     'Off-topic',
    other:         'Other',
  };

  const PIPELINE_COLORS: Record<string, string> = {
    chunk: '#4da3ff',
    fact:  '#28a745',
    llm:   '#9b59b6',
  };

  // ── State ──────────────────────────────────────────────────────────────
  let conversations = $state<ConversationItem[]>(data.conversations);
  let stats = $state(data.stats);
  let total = $state(data.total);

  let filterMode = $state<'all' | 'unreviewed' | 'reviewed'>(data.filter as 'all' | 'unreviewed' | 'reviewed');
  let pipelineFilter = $state<'all' | 'chunk' | 'fact' | 'llm'>(data.pipeline as 'all' | 'chunk' | 'fact' | 'llm');

  let selected = $state<Set<string>>(new Set());
  let expandedId = $state<string | null>(null);
  let detailCache = $state<Record<string, ConversationDetail>>({});
  let editingId = $state<string | null>(null);
  let editDraft = $state<{ question: string; answer: string; trainingWeight: number | null }>({ question: '', answer: '', trainingWeight: null });

  let loading = $state(false);
  let actionMsg = $state('');

  // ── Data loading ────────────────────────────────────────────────────────
  async function reload() {
    loading = true;
    try {
      const params = new URLSearchParams({ filter: filterMode, pipeline: pipelineFilter });
      const res = await fetch(`/api/conversations?${params}`);
      if (res.ok) {
        const d = await res.json();
        conversations = d.items;
        total = d.total;
        stats = d.stats;
        selected = new Set();
      }
    } finally {
      loading = false;
    }
  }

  async function loadDetail(id: string) {
    if (detailCache[id]) return;
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) {
      detailCache[id] = await res.json();
    }
  }

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      expandedId = null;
    } else {
      expandedId = id;
      await loadDetail(id);
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  async function startEdit(item: ConversationItem) {
    await loadDetail(item.id);
    editDraft = {
      question: item.question,
      answer: item.answer,
      trainingWeight: item.trainingWeight,
    };
    editingId = item.id;
  }

  async function saveEdit(id: string) {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: editDraft.question,
        answer: editDraft.answer,
        trainingWeight: editDraft.trainingWeight,
      }),
    });
    if (res.ok) {
      const updated = await res.json();
      const idx = conversations.findIndex((c) => c.id === id);
      if (idx >= 0) {
        conversations[idx] = { ...conversations[idx], ...updated };
      }
      if (detailCache[id]) {
        detailCache[id] = { ...detailCache[id], ...updated };
      }
      editingId = null;
      flash('Saved');
    }
  }

  async function toggleReviewed(item: ConversationItem) {
    const markReviewedFlag = !item.reviewedAt;
    const res = await fetch(`/api/conversations/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markReviewedFlag }),
    });
    if (res.ok) {
      const updated = await res.json();
      const idx = conversations.findIndex((c) => c.id === item.id);
      if (idx >= 0) conversations[idx] = { ...conversations[idx], ...updated };
      stats = { ...stats, reviewed: stats.reviewed + (markReviewedFlag ? 1 : -1), unreviewed: stats.unreviewed + (markReviewedFlag ? -1 : 1) };
    }
  }

  async function deleteSingle(id: string) {
    if (!confirm('Delete this conversation?')) return;
    const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      conversations = conversations.filter((c) => c.id !== id);
      selected.delete(id);
      total--;
      flash('Deleted');
    }
  }

  async function batchDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} conversation(s)?`)) return;
    const res = await fetch('/api/conversations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) {
      conversations = conversations.filter((c) => !selected.has(c.id));
      total -= ids.length;
      selected = new Set();
      flash(`Deleted ${ids.length}`);
    }
  }

  async function exportSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const res = await fetch('/api/conversations/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) {
      const d = await res.json();
      await reload();
      flash(`Exported ${d.exported} (${d.chosen} chosen, ${d.rejected} rejected)`);
    }
  }

  async function exportSingle(id: string) {
    const res = await fetch('/api/conversations/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    if (res.ok) {
      await reload();
      flash('Added to dataset');
    }
  }

  async function batchMarkReviewed() {
    const ids = [...selected];
    for (const id of ids) {
      const item = conversations.find((c) => c.id === id);
      if (item && !item.reviewedAt) await toggleReviewed(item);
    }
    selected = new Set();
    flash(`Marked ${ids.length} as reviewed`);
  }

  function flash(msg: string) {
    actionMsg = msg;
    setTimeout(() => { actionMsg = ''; }, 2500);
  }

  function toggleSelect(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selected = s;
  }

  function toggleSelectAll() {
    if (selected.size === conversations.length) {
      selected = new Set();
    } else {
      selected = new Set(conversations.map((c) => c.id));
    }
  }

  function clampWeight(val: number): number {
    return Math.max(0.3, Math.min(2.0, val));
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });
  }
</script>

<svelte:head>
  <title>Conversations</title>
</svelte:head>

<div class="page">
  <header class="page-header">
    <div class="header-top">
      <h1>Conversations</h1>
      {#if actionMsg}
        <span class="flash-msg">{actionMsg}</span>
      {/if}
    </div>

    <!-- Stats bar -->
    <div class="stats-bar">
      <div class="stat-pill">
        <span class="stat-num">{stats.total}</span>
        <span class="stat-lbl">Total</span>
      </div>
      <div class="stat-pill warning">
        <span class="stat-num">{stats.unreviewed}</span>
        <span class="stat-lbl">Unreviewed</span>
      </div>
      <div class="stat-pill success">
        <span class="stat-num">{stats.reviewed}</span>
        <span class="stat-lbl">Reviewed</span>
      </div>
      <div class="stat-pill up">
        <span class="stat-num">{stats.thumbsUp}</span>
        <span class="stat-lbl">👍 Upvoted</span>
      </div>
      <div class="stat-pill down">
        <span class="stat-num">{stats.thumbsDown}</span>
        <span class="stat-lbl">👎 Downvoted</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="filter-bar">
      <div class="filter-group">
        <span class="filter-label">Status</span>
        <div class="btn-group">
          {#each [['all','All'],['unreviewed','Unreviewed'],['reviewed','Reviewed']] as [val, lbl]}
            <button
              class="btn-seg"
              class:active={filterMode === val}
              onclick={() => { filterMode = val as typeof filterMode; reload(); }}
            >{lbl}</button>
          {/each}
        </div>
      </div>
      <div class="filter-group">
        <span class="filter-label">Pipeline</span>
        <div class="btn-group">
          {#each [['all','All'],['chunk','Chunk'],['fact','Fact'],['llm','LLM']] as [val, lbl]}
            <button
              class="btn-seg"
              class:active={pipelineFilter === val}
              onclick={() => { pipelineFilter = val as typeof pipelineFilter; reload(); }}
            >{lbl}</button>
          {/each}
        </div>
      </div>

      <button class="btn btn-secondary btn-sm refresh-btn" onclick={reload} disabled={loading}>
        {#if loading}<span class="spinner-small"></span>{:else}↻{/if}
      </button>
    </div>
  </header>

  <!-- Batch action toolbar -->
  {#if selected.size > 0}
    <div class="batch-bar">
      <span class="batch-count">{selected.size} selected</span>
      <button class="btn btn-primary btn-sm" onclick={exportSelected}>Add to Dataset</button>
      <button class="btn btn-secondary btn-sm" onclick={batchMarkReviewed}>Mark Reviewed</button>
      <button class="btn btn-danger btn-sm" onclick={batchDelete}>Delete</button>
      <button class="btn btn-secondary btn-sm" onclick={() => selected = new Set()}>Deselect all</button>
    </div>
  {/if}

  <!-- Table -->
  {#if conversations.length === 0}
    <div class="empty-state">
      <p>No conversations yet.</p>
      <p class="hint">Start chatting on the Dashboard and the conversations will appear here.</p>
    </div>
  {:else}
    <div class="conv-table-wrap">
      <table class="conv-table">
        <thead>
          <tr>
            <th class="col-check">
              <input type="checkbox"
                checked={selected.size === conversations.length && conversations.length > 0}
                onchange={toggleSelectAll}
              />
            </th>
            <th class="col-status">Status</th>
            <th class="col-question">Question</th>
            <th class="col-answer">Answer</th>
            <th class="col-pipe">Pipeline</th>
            <th class="col-rating">Rating</th>
            <th class="col-category">Category</th>
            <th class="col-weight">Weight</th>
            <th class="col-date">Date</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each conversations as conv (conv.id)}
            <!-- Main row -->
            <tr class="conv-row" class:selected={selected.has(conv.id)} class:expanded={expandedId === conv.id}>
              <td class="col-check"><input type="checkbox" checked={selected.has(conv.id)} onchange={() => toggleSelect(conv.id)} /></td>
              <td class="col-status">
                {#if conv.reviewedAt}
                  <span class="status-badge reviewed" title="Reviewed {formatDate(conv.reviewedAt)}">✓</span>
                {:else}
                  <span class="status-badge unreviewed" title="Not reviewed"></span>
                {/if}
              </td>
              <td class="col-question">
                <button class="text-btn" onclick={() => toggleExpand(conv.id)}>
                  {conv.question.length > 80 ? conv.question.slice(0, 80) + '…' : conv.question}
                </button>
              </td>
              <td class="col-answer">
                <span class="answer-preview">
                  {conv.answer.length > 100 ? conv.answer.slice(0, 100) + '…' : conv.answer}
                </span>
              </td>
              <td class="col-pipe">
                <span class="pipe-badge" style="color:{PIPELINE_COLORS[conv.pipeline] ?? '#ccc'}">{conv.pipeline}</span>
              </td>
              <td class="col-rating">
                {#if conv.rating === 'up'}
                  <span class="rating-icon up" title="Upvoted">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1 8.5a1.5 1.5 0 113 0v4.5a1.5 1.5 0 01-3 0V8.5zM5 8v4.43a1 1 0 00.553.894l.025.013A3 3 0 006.943 14h4.057a1 1 0 00.981-.804l.9-4.5A1 1 0 0011.9 7.5H9.5V3a1 1 0 00-1-1 .5.5 0 00-.5.5v.167A3 3 0 017.6 4.567L5.8 7.2A2 2 0 005 8z"/></svg>
                  </span>
                {:else if conv.rating === 'down'}
                  <span class="rating-icon down" title="Downvoted">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M15 7.5a1.5 1.5 0 11-3 0V3a1.5 1.5 0 013 0v4.5zM11 8V3.57a1 1 0 00-.553-.894l-.025-.013A3 3 0 009.057 2H5a1 1 0 00-.981.804l-.9 4.5A1 1 0 004.1 8.5H6.5V13a1 1 0 001 1 .5.5 0 00.5-.5v-.167a3 3 0 01.4-1.4L10.2 8.8A2 2 0 0011 8z"/></svg>
                  </span>
                {:else}
                  <span class="rating-none">—</span>
                {/if}
              </td>
              <td class="col-category">
                {#if conv.ratingCategory}
                  <span class="cat-tag">{RATING_CATEGORIES[conv.ratingCategory] ?? conv.ratingCategory}</span>
                {:else}
                  <span class="none-text">—</span>
                {/if}
              </td>
              <td class="col-weight">
                {#if conv.trainingWeight !== null && conv.trainingWeight !== undefined}
                  <span class="weight-val" title="Training weight">{conv.trainingWeight.toFixed(2)}</span>
                {:else}
                  <span class="none-text">—</span>
                {/if}
              </td>
              <td class="col-date">
                <span class="date-text">{formatDate(conv.createdAt)}</span>
              </td>
              <td class="col-actions">
                <div class="action-btns">
                  <button class="icon-btn" title="Expand" onclick={() => toggleExpand(conv.id)}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                      {#if expandedId === conv.id}
                        <path stroke-linecap="round" stroke-linejoin="round" d="M4 10l4-4 4 4"/>
                      {:else}
                        <path stroke-linecap="round" stroke-linejoin="round" d="M4 6l4 4 4-4"/>
                      {/if}
                    </svg>
                  </button>
                  <button class="icon-btn" title="Edit" onclick={() => startEdit(conv)}>✏️</button>
                  <button
                    class="icon-btn"
                    title={conv.reviewedAt ? 'Mark unreviewed' : 'Mark reviewed'}
                    onclick={() => toggleReviewed(conv)}
                  >{conv.reviewedAt ? '↩' : '✓'}</button>
                  <button class="icon-btn" title="Add to dataset" onclick={() => exportSingle(conv.id)}>⬆</button>
                  <button class="icon-btn danger" title="Delete" onclick={() => deleteSingle(conv.id)}>🗑</button>
                </div>
              </td>
            </tr>

            <!-- Expanded detail row -->
            {#if expandedId === conv.id}
              <tr class="detail-row">
                <td colspan="10">
                  <div class="detail-panel">
                    {#if detailCache[conv.id]}
                      {@const detail = detailCache[conv.id]}
                      <div class="detail-grid">
                        <div class="detail-col">
                          <div class="detail-section">
                            <div class="detail-label">Question</div>
                            <div class="detail-text">{detail.question}</div>
                          </div>
                          <div class="detail-section">
                            <div class="detail-label">Answer</div>
                            <div class="detail-text">{detail.answer}</div>
                          </div>
                          {#if detail.ratingFreetext}
                            <div class="detail-section">
                              <div class="detail-label">Feedback Note</div>
                              <div class="detail-text muted">"{detail.ratingFreetext}"</div>
                            </div>
                          {/if}
                        </div>
                        <div class="detail-col">
                          <div class="detail-section">
                            <div class="detail-label">Retrieved Context ({detail.context.length} chunks)</div>
                            <div class="context-list">
                              {#each detail.context as chunk, i}
                                <div class="context-chunk">
                                  <span class="chunk-num">[{i+1}]</span>
                                  <span class="chunk-text">{chunk}</span>
                                </div>
                              {/each}
                            </div>
                          </div>
                          {#if detail.sources.length > 0}
                            <div class="detail-section">
                              <div class="detail-label">Sources</div>
                              {#each detail.sources as src}
                                <div class="source-row">
                                  {#if src.title}<span class="src-title">{src.title}</span>{/if}
                                  {#if src.url}<a href={src.url} target="_blank" rel="noopener" class="src-url">{src.url}</a>{/if}
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      </div>
                    {:else}
                      <div class="loading-inline"><span class="spinner-small"></span> Loading…</div>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}

            <!-- Edit row -->
            {#if editingId === conv.id}
              <tr class="edit-row">
                <td colspan="10">
                  <div class="edit-panel">
                    <h3 class="edit-title">Edit Conversation</h3>
                    <div class="edit-grid">
                      <div class="edit-field">
                        <label class="edit-label" for="edit-q-{conv.id}">Question</label>
                        <textarea id="edit-q-{conv.id}" class="edit-textarea" rows="3" bind:value={editDraft.question}></textarea>
                      </div>
                      <div class="edit-field">
                        <label class="edit-label" for="edit-a-{conv.id}">Answer</label>
                        <textarea id="edit-a-{conv.id}" class="edit-textarea" rows="5" bind:value={editDraft.answer}></textarea>
                      </div>
                    </div>
                    <div class="edit-weight-row">
                      <label class="edit-label" for="edit-w-{conv.id}">Training Weight</label>
                      <div class="weight-control">
                        <input
                          id="edit-w-{conv.id}"
                          type="range"
                          min="0.3" max="2.0" step="0.05"
                          value={editDraft.trainingWeight ?? 1.0}
                          oninput={(e) => { editDraft.trainingWeight = clampWeight(parseFloat((e.target as HTMLInputElement).value)); }}
                          class="weight-slider"
                        />
                        <input
                          type="number"
                          min="0.3" max="2.0" step="0.05"
                          value={editDraft.trainingWeight ?? 1.0}
                          oninput={(e) => { editDraft.trainingWeight = clampWeight(parseFloat((e.target as HTMLInputElement).value) || 1.0); }}
                          class="weight-number"
                        />
                        <span class="weight-range-hint">[0.3 – 2.0]</span>
                      </div>
                    </div>
                    <div class="edit-actions">
                      <button class="btn btn-primary btn-sm" onclick={() => saveEdit(conv.id)}>Save</button>
                      <button class="btn btn-secondary btn-sm" onclick={() => editingId = null}>Cancel</button>
                    </div>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    {#if total > conversations.length}
      <div class="load-more-hint">Showing {conversations.length} of {total}. Use filters to narrow down.</div>
    {/if}
  {/if}
</div>

<style>
  .page {
    padding: 24px 32px;
    max-width: 1400px;
    color: #e0e0e0;
  }

  /* ── Header ─────────────────────────────────────────────────────── */
  .page-header { margin-bottom: 20px; }
  .header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
  h1 { font-size: 1.6rem; font-weight: 700; color: #fff; margin: 0; }

  .flash-msg {
    font-size: 0.82rem;
    color: #6366f1;
    background: rgba(99,102,241,0.12);
    padding: 4px 12px;
    border-radius: 20px;
    border: 1px solid rgba(99,102,241,0.3);
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; } }

  /* ── Stats bar ──────────────────────────────────────────────────── */
  .stats-bar {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }

  .stat-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 18px;
    background: #2d2d2d;
    border: 1px solid #3a3a3a;
    border-radius: 10px;
    min-width: 72px;
  }

  .stat-pill.warning { border-color: #b45309; }
  .stat-pill.success { border-color: #16a34a; }
  .stat-pill.up      { border-color: #6366f1; }
  .stat-pill.down    { border-color: #dc3545; }

  .stat-num { font-size: 1.4rem; font-weight: 700; color: #fff; line-height: 1.1; }
  .stat-lbl { font-size: 0.7rem; color: #888; margin-top: 2px; }

  /* ── Filter bar ─────────────────────────────────────────────────── */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .filter-group { display: flex; align-items: center; gap: 8px; }
  .filter-label { font-size: 0.78rem; color: #888; white-space: nowrap; }

  .btn-group {
    display: flex;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    overflow: hidden;
  }

  .btn-seg {
    padding: 5px 12px;
    background: #2d2d2d;
    border: none;
    border-right: 1px solid #3a3a3a;
    color: #888;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .btn-seg:last-child { border-right: none; }
  .btn-seg.active { background: #6366f1; color: #fff; }
  .btn-seg:hover:not(.active) { background: #373737; color: #ccc; }

  .refresh-btn { margin-left: auto; }

  /* ── Batch bar ──────────────────────────────────────────────────── */
  .batch-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: rgba(99,102,241,0.1);
    border: 1px solid rgba(99,102,241,0.3);
    border-radius: 8px;
    margin-bottom: 12px;
  }

  .batch-count { font-size: 0.85rem; color: #818cf8; font-weight: 600; margin-right: 4px; }

  /* ── Shared btn helpers ─────────────────────────────────────────── */
  .btn { padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 0.85rem; transition: filter 0.12s; }
  .btn-primary  { background: #6366f1; color: #fff; }
  .btn-secondary{ background: #373737; color: #ccc; border: 1px solid #444; }
  .btn-danger   { background: #7f1d1d; color: #fca5a5; border: 1px solid #dc3545; }
  .btn-sm       { padding: 4px 10px; font-size: 0.78rem; }
  .btn:hover    { filter: brightness(1.15); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Empty state ────────────────────────────────────────────────── */
  .empty-state { text-align: center; padding: 60px 0; color: #666; }
  .empty-state .hint { font-size: 0.85rem; color: #555; margin-top: 8px; }

  /* ── Table ──────────────────────────────────────────────────────── */
  .conv-table-wrap {
    overflow-x: auto;
    border: 1px solid #333;
    border-radius: 10px;
  }

  .conv-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .conv-table thead { background: #242424; }

  .conv-table th {
    padding: 10px 12px;
    text-align: left;
    font-size: 0.75rem;
    font-weight: 600;
    color: #888;
    border-bottom: 1px solid #333;
    white-space: nowrap;
  }

  .conv-table td { padding: 10px 12px; border-bottom: 1px solid #2a2a2a; vertical-align: middle; }

  .conv-row { background: #1e1e1e; transition: background 0.1s; }
  .conv-row:hover { background: #252525; }
  .conv-row.selected { background: rgba(99,102,241,0.06); }
  .conv-row.expanded { background: #252530; }

  /* Column widths */
  .col-check    { width: 36px; }
  .col-status   { width: 48px; text-align: center; }
  .col-question { min-width: 180px; max-width: 280px; }
  .col-answer   { min-width: 160px; max-width: 280px; }
  .col-pipe     { width: 70px; }
  .col-rating   { width: 48px; text-align: center; }
  .col-category { width: 100px; }
  .col-weight   { width: 68px; text-align: center; }
  .col-date     { width: 110px; white-space: nowrap; }
  .col-actions  { width: 130px; }

  /* Cell content */
  .status-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    font-size: 0.72rem;
  }

  .status-badge.reviewed { background: rgba(22,163,74,0.2); color: #4ade80; border: 1px solid #16a34a; }
  .status-badge.unreviewed {
    background: rgba(180,83,9,0.2);
    border: 1px solid #b45309;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }

  .text-btn {
    background: none;
    border: none;
    color: #c5c5e0;
    cursor: pointer;
    text-align: left;
    font-size: 0.84rem;
    line-height: 1.4;
    padding: 0;
  }
  .text-btn:hover { color: #818cf8; }

  .answer-preview { color: #888; font-size: 0.8rem; line-height: 1.4; }

  .pipe-badge { font-size: 0.78rem; font-weight: 600; }

  .rating-icon.up   { color: #4ade80; display: inline-flex; }
  .rating-icon.down { color: #f87171; display: inline-flex; }
  .rating-none { color: #555; font-size: 0.8rem; }

  .cat-tag {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(99,102,241,0.12);
    color: #818cf8;
    font-size: 0.72rem;
  }

  .weight-val { font-size: 0.82rem; font-weight: 600; color: #c5c5e0; }

  .date-text { font-size: 0.75rem; color: #666; }

  .none-text { color: #555; font-size: 0.8rem; }

  /* Action buttons */
  .action-btns { display: flex; gap: 4px; align-items: center; }

  .icon-btn {
    background: none;
    border: 1px solid #333;
    border-radius: 5px;
    color: #888;
    font-size: 0.75rem;
    cursor: pointer;
    padding: 3px 6px;
    transition: border-color 0.1s, color 0.1s, background 0.1s;
    display: inline-flex;
    align-items: center;
  }
  .icon-btn:hover       { border-color: #6366f1; color: #818cf8; background: rgba(99,102,241,0.08); }
  .icon-btn.danger:hover{ border-color: #dc3545; color: #f87171; background: rgba(220,53,69,0.08); }

  /* ── Detail panel ───────────────────────────────────────────────── */
  .detail-row td, .edit-row td { padding: 0; background: #1a1a2e; }

  .detail-panel {
    padding: 20px 24px;
    border-top: 2px solid rgba(99,102,241,0.3);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }

  @media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }

  .detail-section { margin-bottom: 16px; }
  .detail-label { font-size: 0.72rem; font-weight: 600; color: #6366f1; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .detail-text { font-size: 0.85rem; color: #ccc; line-height: 1.6; white-space: pre-wrap; }
  .detail-text.muted { color: #888; font-style: italic; }

  .context-list { display: flex; flex-direction: column; gap: 8px; }
  .context-chunk { display: flex; gap: 8px; align-items: flex-start; }
  .chunk-num { font-size: 0.72rem; color: #4da3ff; font-weight: 600; flex-shrink: 0; margin-top: 2px; }
  .chunk-text { font-size: 0.8rem; color: #aaa; line-height: 1.5; }

  .source-row { font-size: 0.78rem; margin-bottom: 4px; }
  .src-title { color: #ccc; margin-right: 8px; }
  .src-url { color: #4da3ff; word-break: break-all; }

  .loading-inline { display: flex; align-items: center; gap: 8px; color: #888; font-size: 0.85rem; padding: 16px; }

  /* ── Edit panel ─────────────────────────────────────────────────── */
  .edit-panel { padding: 20px 24px; border-top: 2px solid rgba(99,102,241,0.5); }
  .edit-title { font-size: 1rem; font-weight: 600; color: #818cf8; margin: 0 0 16px; }

  .edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 900px) { .edit-grid { grid-template-columns: 1fr; } }

  .edit-field { display: flex; flex-direction: column; gap: 6px; }
  .edit-label { font-size: 0.75rem; font-weight: 600; color: #888; }
  .edit-textarea {
    background: #2d2d2d;
    border: 1px solid #444;
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.85rem;
    padding: 8px 10px;
    resize: vertical;
    font-family: inherit;
    line-height: 1.5;
  }
  .edit-textarea:focus { outline: none; border-color: #6366f1; }

  .edit-weight-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .weight-control { display: flex; align-items: center; gap: 10px; flex: 1; }
  .weight-slider { flex: 1; min-width: 140px; accent-color: #6366f1; }
  .weight-number {
    width: 64px;
    background: #2d2d2d;
    border: 1px solid #444;
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 0.85rem;
    padding: 4px 8px;
    text-align: center;
  }
  .weight-number:focus { outline: none; border-color: #6366f1; }
  .weight-range-hint { font-size: 0.72rem; color: #666; white-space: nowrap; }

  .edit-actions { display: flex; gap: 10px; }

  /* ── Load more hint ─────────────────────────────────────────────── */
  .load-more-hint { text-align: center; font-size: 0.8rem; color: #555; margin-top: 12px; }

  /* ── Spinner ────────────────────────────────────────────────────── */
  .spinner-small {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #444;
    border-top-color: #6366f1;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
