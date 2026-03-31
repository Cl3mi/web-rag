<script lang="ts">
  import ChatWidget from '$lib/components/ChatWidget.svelte';
  import { invalidateAll } from '$app/navigation';

  interface Props {
    data: { bgColor: string; primaryColor: string; title: string; badgeLabel: string; badgeUrl: string };
  }
  let { data }: Props = $props();

  // Seed from server; user edits flow back via debounced save
  let bgColor = $state(data.bgColor);
  let primaryColor = $state(data.primaryColor);
  let title = $state(data.title);
  let badgeLabel = $state(data.badgeLabel);
  let badgeUrl = $state(data.badgeUrl);
  let saveStatus = $state<'idle' | 'saving' | 'saved'>('idle');

  // Debounced auto-save: skip the very first run (initial values from server)
  let firstRun = true;
  $effect(() => {
    const bg = bgColor;
    const primary = primaryColor;
    const t = title;
    const bl = badgeLabel;
    const bu = badgeUrl;
    if (firstRun) { firstRun = false; return; }

    saveStatus = 'saving';
    const id = setTimeout(async () => {
      await fetch('/api/widget/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bgColor: bg, primaryColor: primary, title: t, badgeLabel: bl, badgeUrl: bu }),
      });
      saveStatus = 'saved';
      await invalidateAll();
      setTimeout(() => (saveStatus = 'idle'), 1500);
    }, 500);

    return () => clearTimeout(id);
  });

  const embedCode = $derived(
    `<script src="https://your-server.com/widget/chat-widget.iife.js"><\/script>\n<chat-widget api-url="https://your-server.com" title="Assistant"></chat-widget>`
  );

  let copied = $state(false);

  async function copyEmbed() {
    await navigator.clipboard.writeText(embedCode);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function resetColors() {
    bgColor = '#16171d';
    primaryColor = '#6366f1';
    title = 'Assistant';
    badgeLabel = '';
    badgeUrl = '';
  }
</script>

<svelte:head>
  <title>Settings — RAG Pipeline Lab</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>Chat Widget</h1>
    <p class="subtitle">Embed the RAG chat assistant on any website as a web component.</p>
  </div>

  <div class="content">
    <!-- Left: info + controls -->
    <div class="info-col">

      <!-- Content -->
      <section class="card">
        <div class="card-header">
          <h2>Content</h2>
          {#if saveStatus === 'saving'}
            <span class="save-status saving">Saving…</span>
          {:else if saveStatus === 'saved'}
            <span class="save-status saved">Saved</span>
          {/if}
        </div>
        <div class="field-rows">
          <div class="field-row">
            <label for="title-input">Title</label>
            <input id="title-input" class="text-input" type="text" bind:value={title} placeholder="Assistant" maxlength="100" />
          </div>
          <div class="field-row">
            <label for="badge-label">Badge text</label>
            <input id="badge-label" class="text-input" type="text" bind:value={badgeLabel} placeholder="Leave empty to hide" maxlength="60" />
          </div>
          <div class="field-row">
            <label for="badge-url">Badge link</label>
            <input id="badge-url" class="text-input" type="url" bind:value={badgeUrl} placeholder="https://… (optional)" maxlength="500" />
          </div>
        </div>
      </section>

      <!-- Appearance -->
      <section class="card">
        <h2>Appearance</h2>
        <div class="color-rows">
          <div class="color-row">
            <label for="bg-color">Background</label>
            <div class="color-field">
              <input id="bg-color" type="color" bind:value={bgColor} />
              <span class="hex-value">{bgColor}</span>
            </div>
          </div>
          <div class="color-row">
            <label for="primary-color">Primary</label>
            <div class="color-field">
              <input id="primary-color" type="color" bind:value={primaryColor} />
              <span class="hex-value">{primaryColor}</span>
            </div>
          </div>
        </div>
        <button class="reset-btn" onclick={resetColors}>Reset to defaults</button>
      </section>

      <!-- Embed Code -->
      <section class="card">
        <h2>Embed Code</h2>
        <p class="desc">
          Build the widget with <code>bun run build:widget</code>, then include it on any page.
          Set <code>api-url</code> to this server's origin.
        </p>
        <div class="code-block">
          <pre>{embedCode}</pre>
          <button class="copy-btn" onclick={copyEmbed}>
            {#if copied}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Copied!
            {:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
              </svg>
              Copy
            {/if}
          </button>
        </div>
      </section>
    </div>

    <!-- Right: live preview -->
    <div class="preview-col">
      <div class="preview-label">Live Preview</div>
      <div class="preview-container">
        <ChatWidget {title} {bgColor} {primaryColor} {badgeLabel} {badgeUrl} />
      </div>
    </div>
  </div>
</div>

<style>
  .page {
    padding: 32px 36px;
    max-width: 1200px;
    color: #e2e8f0;
  }

  .page-header {
    margin-bottom: 32px;
  }
  .page-header h1 {
    font-size: 1.75rem;
    font-weight: 700;
    color: #f1f5f9;
    margin: 0 0 6px;
  }
  .subtitle {
    color: #64748b;
    font-size: 0.95rem;
    margin: 0;
  }

  .content {
    display: flex;
    gap: 32px;
    align-items: flex-start;
  }

  .info-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .preview-col {
    flex-shrink: 0;
  }
  .preview-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #475569;
    margin-bottom: 10px;
  }
  .preview-container {
    /* no drop-shadow — widget has its own subtle border */
  }

  /* Cards */
  .card {
    background: #252525;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 12px;
    padding: 20px 22px;
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .card h2 {
    font-size: 0.9rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  /* Direct h2 (not inside .card-header) needs its own bottom margin */
  .card > h2 { margin-bottom: 14px; }
  .save-status {
    font-size: 11px;
    font-weight: 500;
    border-radius: 4px;
    padding: 2px 7px;
  }
  .save-status.saving { color: #94a3b8; background: rgba(99,102,241,0.1); }
  .save-status.saved  { color: #22c55e; background: rgba(34,197,94,0.1); }
  .desc {
    font-size: 0.875rem;
    color: #64748b;
    line-height: 1.6;
    margin: 0 0 14px;
  }
  .desc code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8em;
    background: rgba(99, 102, 241, 0.12);
    color: #818cf8;
    padding: 1px 5px;
    border-radius: 4px;
  }

  /* Color pickers */
  .color-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 14px;
  }
  .color-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .color-row label {
    font-size: 13px;
    color: #94a3b8;
    flex-shrink: 0;
    width: 80px;
  }
  .color-field {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .color-field input[type="color"] {
    width: 36px;
    height: 28px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    background: none;
    cursor: pointer;
    padding: 2px;
  }
  .color-field input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
  .color-field input[type="color"]::-webkit-color-swatch { border-radius: 4px; border: none; }
  .hex-value {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    color: #64748b;
  }
  .reset-btn {
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: #64748b;
    font-size: 12px;
    padding: 5px 12px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .reset-btn:hover { border-color: rgba(255, 255, 255, 0.28); color: #94a3b8; }

  /* Code block */
  .code-block {
    position: relative;
    background: #1a1a1a;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    overflow: hidden;
  }
  .code-block pre {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
    color: #a5b4fc;
    padding: 14px 16px;
    overflow-x: auto;
    margin: 0;
    line-height: 1.6;
    white-space: pre;
  }
  .copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 5px;
    background: rgba(99, 102, 241, 0.15);
    border: 1px solid rgba(99, 102, 241, 0.3);
    border-radius: 6px;
    color: #818cf8;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .copy-btn:hover { background: rgba(99, 102, 241, 0.3); }
  .copy-btn svg { width: 12px; height: 12px; }

  /* Text field rows */
  .field-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .field-row label {
    font-size: 13px;
    color: #94a3b8;
    flex-shrink: 0;
    width: 80px;
  }
  .text-input {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 13px;
    padding: 6px 10px;
    outline: none;
    transition: border-color 0.15s;
    font-family: inherit;
  }
  .text-input::placeholder { color: #4a5568; }
  .text-input:focus { border-color: rgba(99, 102, 241, 0.5); }

  @media (max-width: 900px) {
    .content { flex-direction: column; }
    .preview-col { align-self: center; }
  }
</style>
