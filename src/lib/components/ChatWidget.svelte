<script lang="ts">
  import { tick } from 'svelte';

  interface Source {
    title: string | null;
    url: string | null;
    content: string;
  }

  interface Message {
    id: string;
    role: 'user' | 'bot';
    content: string;
    sources?: Source[];
    streaming: boolean;
    error: boolean;
  }

  let {
    apiUrl = '',
    title = 'Assistant',
    bgColor = '#0d0f1a',
    primaryColor = '#6366f1',
    badgeLabel = '',
    badgeUrl = '',
  }: {
    apiUrl?: string;
    title?: string;
    bgColor?: string;
    primaryColor?: string;
    badgeLabel?: string;
    badgeUrl?: string;
  } = $props();

  function hexToRgb(hex: string): string {
    const h = hex.replace('#', '').padEnd(6, '0');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `${r}, ${g}, ${b}`;
  }

  function getLuminance(hex: string): number {
    const h = hex.replace('#', '').padEnd(6, '0');
    return 0.2126 * (parseInt(h.slice(0, 2), 16) / 255)
         + 0.7152 * (parseInt(h.slice(2, 4), 16) / 255)
         + 0.0722 * (parseInt(h.slice(4, 6), 16) / 255);
  }

  // Shift lightness in HSL space — preserves hue/saturation so surface stays
  // tonally coherent with the bg (dark navy → lighter navy, not desaturated gray)
  function computeSurface(hex: string, isDark: boolean): string {
    const h = hex.replace('#', '').padEnd(6, '0');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let l = (max + min) / 2;
    const s = d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min));
    let hue = 0;
    if (d !== 0) {
      switch (max) {
        case r: hue = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: hue = ((b - r) / d + 2) / 6; break;
        default: hue = ((r - g) / d + 4) / 6;
      }
    }
    l = isDark ? Math.min(l + 0.14, 0.88) : Math.max(l - 0.14, 0.12);
    const sr = s * 0.35; // reduce saturation ~65% — subtle tint, not full chroma
    const a = sr * Math.min(l, 1 - l);
    const k = (n: number) => (n + hue * 12) % 12;
    const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function computeCssVars(bg: string, primary: string): string {
    const isDark = getLuminance(bg) < 0.4;
    return [
      `--cw-bg:${bg}`,
      `--cw-primary:${primary}`,
      `--cw-primary-rgb:${hexToRgb(primary)}`,
      `--cw-text:${isDark ? '#e2e8f0' : '#1a202c'}`,
      `--cw-text-muted:${isDark ? '#94a3b8' : '#4a5568'}`,
      `--cw-text-faint:${isDark ? '#4a5568' : '#94a3b8'}`,
      `--cw-surface:${computeSurface(bg, isDark)}`,
    ].join(';');
  }

  const cssVars = $derived(computeCssVars(bgColor, primaryColor));

  let messages = $state<Message[]>([]);
  let inputValue = $state('');
  let isLoading = $state(false);
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  const baseUrl = $derived(apiUrl.replace(/\/$/, ''));

  // Auto-scroll when messages update
  $effect(() => {
    // Track all message content/streaming state for dependency
    const _key = messages.map((m) => m.id + m.content.length + String(m.streaming)).join('');
    void _key;
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 96) + 'px';
  }

  async function sendMessage() {
    const text = inputValue.trim();
    if (!text || isLoading) return;

    inputValue = '';
    isLoading = true;
    await tick();
    if (textareaEl) textareaEl.style.height = 'auto';

    const botId = crypto.randomUUID();

    messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      streaming: false,
      error: false,
    });

    messages.push({
      id: botId,
      role: 'bot',
      content: '',
      streaming: true,
      error: false,
    });

    try {
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: { type: string; [k: string]: unknown };
          try { event = JSON.parse(raw); } catch { continue; }

          const idx = messages.findIndex((m) => m.id === botId);
          if (idx === -1) continue;

          if (event.type === 'sources') {
            messages[idx].sources = event.sources as Source[];
          } else if (event.type === 'token') {
            messages[idx].content += event.token as string;
          } else if (event.type === 'done') {
            messages[idx].streaming = false;
            isLoading = false;
          } else if (event.type === 'error') {
            messages[idx].content = String(event.error);
            messages[idx].streaming = false;
            messages[idx].error = true;
            isLoading = false;
          }
        }
      }
    } catch (err) {
      const idx = messages.findIndex((m) => m.id === botId);
      if (idx !== -1) {
        messages[idx].content = `Connection error: ${err instanceof Error ? err.message : String(err)}`;
        messages[idx].streaming = false;
        messages[idx].error = true;
      }
    } finally {
      isLoading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
</script>

<div class="cw" style={cssVars}>
  <!-- Header -->
  <div class="cw-header">
    <div class="cw-header-left">
      <span class="cw-dot"></span>
      <span class="cw-title">{title}</span>
    </div>
    {#if badgeLabel}
      {#if badgeUrl}
        <a href={badgeUrl} target="_blank" rel="noopener noreferrer" class="cw-badge">{badgeLabel}</a>
      {:else}
        <span class="cw-badge">{badgeLabel}</span>
      {/if}
    {/if}
  </div>

  <!-- Messages -->
  <div class="cw-messages" bind:this={messagesEl}>
    {#if messages.length === 0}
      <div class="cw-empty">
        <svg class="cw-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
        <p>Ask anything about the knowledge base</p>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      <div class="cw-row cw-row--{msg.role}">
        {#if msg.role === 'bot'}
          <div class="cw-avatar cw-avatar--bot">AI</div>
        {/if}

        <div class="cw-bubble cw-bubble--{msg.role}" class:cw-bubble--error={msg.error}>
          {#if msg.content}
            <div class="cw-text">{msg.content}{#if msg.streaming}<span class="cw-cursor">▊</span>{/if}</div>
          {:else if msg.streaming}
            <div class="cw-typing">
              <span></span><span></span><span></span>
            </div>
          {/if}

          {#if msg.sources && msg.sources.length > 0 && !msg.streaming}
            <div class="cw-sources">
              <span class="cw-sources-label">Sources</span>
              {#each msg.sources.slice(0, 3) as src}
                {#if src.url}
                  <a href={src.url} target="_blank" rel="noopener noreferrer" class="cw-source-link">
                    {src.title || src.url}
                  </a>
                {:else if src.title}
                  <span class="cw-source-item">{src.title}</span>
                {/if}
              {/each}
            </div>
          {/if}
        </div>

        {#if msg.role === 'user'}
          <div class="cw-avatar cw-avatar--user">U</div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Input -->
  <div class="cw-input-area">
    <textarea
      bind:this={textareaEl}
      bind:value={inputValue}
      onkeydown={handleKeydown}
      oninput={autoResize}
      placeholder="Ask a question… (Enter to send)"
      rows={1}
      disabled={isLoading}
    ></textarea>
    <button
      class="cw-send"
      onclick={sendMessage}
      disabled={isLoading || !inputValue.trim()}
      title="Send"
    >
      {#if isLoading}
        <svg class="cw-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 3v3m6.366 1.634-2.12 2.12M21 12h-3m-1.634 6.366-2.12-2.12M12 21v-3m-6.366-1.634 2.12 2.12M3 12h3m1.634-6.366 2.12 2.12" stroke-linecap="round"/>
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M3.478 2.404a.75.75 0 00-.926.941l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.404z"/>
        </svg>
      {/if}
    </button>
  </div>
</div>

<style>
  .cw {
    width: 400px;
    height: 550px;
    display: flex;
    flex-direction: column;
    background: var(--cw-bg, #0d0f1a);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(var(--cw-primary-rgb, 99, 102, 241), 0.1);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    color: var(--cw-text, #e2e8f0);
  }

  /* Header */
  .cw-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: var(--cw-bg, #0d0f1a);
    border-bottom: 1px solid rgba(var(--cw-primary-rgb, 99, 102, 241), 0.25);
    flex-shrink: 0;
  }
  .cw-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cw-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 6px rgba(34, 197, 94, 0.7);
  }
  .cw-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--cw-text, #f1f5f9);
  }
  .cw-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--cw-primary, #818cf8);
    background: rgba(var(--cw-primary-rgb, 99, 102, 241), 0.15);
    border: 1px solid rgba(var(--cw-primary-rgb, 99, 102, 241), 0.3);
    border-radius: 4px;
    padding: 2px 6px;
    text-decoration: none;
    transition: opacity 0.15s;
  }
  a.cw-badge:hover { opacity: 0.75; }

  /* Messages */
  .cw-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
  }
  .cw-messages::-webkit-scrollbar { width: 4px; }
  .cw-messages::-webkit-scrollbar-track { background: transparent; }
  .cw-messages::-webkit-scrollbar-thumb { background: rgba(var(--cw-primary-rgb, 99, 102, 241), 0.3); border-radius: 2px; }

  /* Empty state */
  .cw-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--cw-text-muted, #475569);
    text-align: center;
    padding: 20px;
    margin: auto;
  }
  .cw-empty-icon {
    width: 48px;
    height: 48px;
    color: var(--cw-primary, #6366f1);
    filter: drop-shadow(0 0 10px rgba(var(--cw-primary-rgb, 99, 102, 241), 0.45));
  }
  .cw-empty p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
  }

  /* Message row */
  .cw-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .cw-row--user {
    flex-direction: row-reverse;
  }

  /* Avatar */
  .cw-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }
  .cw-avatar--bot {
    background: linear-gradient(135deg, var(--cw-primary, #4f46e5), var(--cw-primary, #7c3aed));
    color: #fff;
  }
  .cw-avatar--user {
    background: linear-gradient(135deg, #0ea5e9, #2563eb);
    color: #fff;
  }

  /* Bubble */
  .cw-bubble {
    max-width: 78%;
    padding: 10px 14px;
    border-radius: 14px;
    line-height: 1.55;
    word-break: break-word;
  }
  .cw-bubble--bot {
    background: var(--cw-surface, #1a1d2e);
    border: 1px solid rgba(var(--cw-primary-rgb, 99, 102, 241), 0.18);
    border-bottom-left-radius: 4px;
    color: var(--cw-text, #cbd5e1);
  }
  .cw-bubble--user {
    background: linear-gradient(135deg, #3b4fd4, #2563eb);
    border-bottom-right-radius: 4px;
    color: #fff;
    box-shadow: 0 2px 12px rgba(37, 99, 235, 0.3);
  }
  .cw-bubble--error {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.3);
    color: #fca5a5;
  }

  .cw-text {
    white-space: pre-wrap;
    font-size: 13.5px;
  }

  /* Typing dots */
  .cw-typing {
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 2px 0;
  }
  .cw-typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--cw-primary, #6366f1);
    animation: cw-bounce 1.2s ease-in-out infinite;
  }
  .cw-typing span:nth-child(2) { animation-delay: 0.2s; }
  .cw-typing span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes cw-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
    30% { transform: translateY(-6px); opacity: 1; }
  }

  /* Streaming cursor */
  .cw-cursor {
    display: inline-block;
    margin-left: 1px;
    animation: cw-blink 0.8s step-end infinite;
    color: var(--cw-primary, #818cf8);
  }
  @keyframes cw-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* Sources */
  .cw-sources {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(var(--cw-primary-rgb, 99, 102, 241), 0.15);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .cw-sources-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--cw-text-faint, #475569);
    margin-bottom: 2px;
  }
  .cw-source-link, .cw-source-item {
    font-size: 11px;
    color: var(--cw-primary, #818cf8);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }
  .cw-source-link:hover { text-decoration: underline; opacity: 0.8; }

  /* Input area */
  .cw-input-area {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px 14px;
    background: var(--cw-bg, #0a0c18);
    border-top: 1px solid rgba(var(--cw-primary-rgb, 99, 102, 241), 0.15);
    flex-shrink: 0;
  }
  .cw-input-area textarea {
    flex: 1;
    background: var(--cw-surface, #13152a);
    border: 1px solid rgba(var(--cw-primary-rgb, 99, 102, 241), 0.25);
    border-radius: 10px;
    padding: 9px 12px;
    color: var(--cw-text, #e2e8f0);
    font-size: 13.5px;
    font-family: inherit;
    resize: none;
    outline: none;
    line-height: 1.45;
    min-height: 36px;
    max-height: 96px;
    overflow-y: auto;
    transition: border-color 0.15s;
  }
  .cw-input-area textarea::placeholder { color: var(--cw-text-faint, #334155); }
  .cw-input-area textarea:focus { border-color: rgba(var(--cw-primary-rgb, 99, 102, 241), 0.6); }
  .cw-input-area textarea:disabled { opacity: 0.5; cursor: not-allowed; }

  .cw-send {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    border: none;
    background: var(--cw-primary, #6366f1);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s, transform 0.1s;
  }
  .cw-send:hover:not(:disabled) { opacity: 0.85; transform: scale(1.05); }
  .cw-send:active:not(:disabled) { transform: scale(0.95); }
  .cw-send:disabled { opacity: 0.3; cursor: not-allowed; }
  .cw-send svg { width: 16px; height: 16px; }

  /* Spinner animation */
  .cw-spin {
    animation: cw-rotate 0.8s linear infinite;
  }
  @keyframes cw-rotate {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
