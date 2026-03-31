<script lang="ts">
  import '../app.css';
  import favicon from '$lib/assets/favicon.svg';
  import { page } from '$app/state';
  import ChatWidget from '$lib/components/ChatWidget.svelte';

  interface Props {
    children: import('svelte').Snippet;
    data: { widgetBgColor: string; widgetPrimaryColor: string; widgetTitle: string; widgetBadgeLabel: string; widgetBadgeUrl: string; widgetClosed: boolean };
  }

  let { children, data }: Props = $props();

  function setClosedCookie() {
    document.cookie = 'cw_closed=1; path=/; SameSite=Lax';
  }

  function hexToRgb(hex: string): string {
    const h = hex.replace('#', '').padEnd(6, '0');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `${r}, ${g}, ${b}`;
  }
  const floatBtnVars = $derived(
    `--wb-primary:${data.widgetPrimaryColor};--wb-primary-rgb:${hexToRgb(data.widgetPrimaryColor)}`
  );

  const navItems = [
    { href: '/', label: 'Dashboard', icon: '📊' },
    { href: '/crawl', label: 'Crawl', icon: '🌐' },
    { href: '/knowledge', label: 'Knowledge', icon: '📚' },
    { href: '/evaluate', label: 'Evaluate', icon: '📈' },
    { href: '/quality', label: 'Quality', icon: '🎯' },
    { href: '/settings', label: 'Widget', icon: '💬' },
  ];

  // Floating widget is shown on all pages except /settings (where it's embedded in-page)
  const showFloat = $derived(!page.url.pathname.startsWith('/settings'));

  // Start collapsed if the user closed it earlier this session
  let expanded = $state(!data.widgetClosed);
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>RAG Pipeline Lab</title>
</svelte:head>

<div class="app-layout">
  <nav class="sidebar">
    <div class="logo">
      <span class="logo-text">RAG Lab</span>
    </div>

    <ul class="nav-list">
      {#each navItems as item}
        <li>
          <a href={item.href} class="nav-link" class:active={page.url.pathname === item.href}>
            <span class="nav-icon">{item.icon}</span>
            <span class="nav-label">{item.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  <main class="main-content">
    {@render children()}
  </main>
</div>

<!-- Floating chat widget (hidden on /settings where it's shown inline) -->
{#if showFloat}
  <div class="chat-float">
    {#if expanded}
      <div class="chat-float-panel">
        <ChatWidget bgColor={data.widgetBgColor} primaryColor={data.widgetPrimaryColor} title={data.widgetTitle} badgeLabel={data.widgetBadgeLabel} badgeUrl={data.widgetBadgeUrl} />
      </div>
    {/if}

    <button
      class="chat-float-btn"
      class:chat-float-btn--open={expanded}
      onclick={() => { if (expanded) setClosedCookie(); expanded = !expanded; }}
      title={expanded ? 'Close chat' : 'Open chat'}
      style={floatBtnVars}
    >
      {#if expanded}
        <!-- X icon -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      {:else}
        <!-- Chat bubble icon -->
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 00-1.032-.211 50.89 50.89 0 00-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 002.433 3.984L7.28 21.53A.75.75 0 016 21v-4.03a48.527 48.527 0 01-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979z" />
          <path d="M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 001.28-.531v-2.2c1.41-.377 2.5-1.548 2.5-2.993v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0015.75 7.5z" />
        </svg>
      {/if}
    </button>
  </div>
{/if}

<style>
  .app-layout {
    display: flex;
    min-height: 100vh;
  }

  .sidebar {
    width: 220px;
    background: #242424;
    border-right: 1px solid #333;
    display: flex;
    flex-direction: column;
    padding: 20px 0;
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 20px 20px;
    border-bottom: 1px solid #333;
    margin-bottom: 20px;
  }

  .logo-text {
    font-size: 1.25rem;
    font-weight: 600;
    color: #fff;
  }

  .nav-list {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
  }

  .nav-link {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    color: #999;
    text-decoration: none;
    transition: all 0.15s ease;
  }

  .nav-link:hover,
  .nav-link.active {
    background: rgba(255, 255, 255, 0.05);
    color: #fff;
    text-decoration: none;
  }

  .nav-link.active {
    color: #818cf8;
    background: rgba(99, 102, 241, 0.1);
  }

  .nav-icon {
    font-size: 1.1rem;
  }

  .nav-label {
    font-size: 0.95rem;
  }

  .main-content {
    flex: 1;
    margin-left: 220px;
    min-height: 100vh;
    overflow-y: auto;
  }

  /* Floating chat widget */
  .chat-float {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 12px;
  }

  .chat-float-panel {
    animation: cfl-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    transform-origin: bottom right;
  }

  /* Remove shadow from the floating widget — position alone provides context */
  .chat-float-panel :global(.cw) {
    box-shadow: none;
  }

  @keyframes cfl-in {
    from { opacity: 0; transform: scale(0.85); }
    to   { opacity: 1; transform: scale(1); }
  }

  .chat-float-btn {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    background: var(--wb-primary, #6366f1);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: filter 0.15s, transform 0.15s, box-shadow 0.15s;
    flex-shrink: 0;
  }

  .chat-float-btn:active {
    transform: scale(0.95);
  }

  .chat-float-btn--open {
    background: var(--wb-primary, #6366f1);
  }

  .chat-float-btn--open:hover {
    filter: none;
  }

  .chat-float-btn svg {
    width: 22px;
    height: 22px;
  }

  @media (max-width: 768px) {
    .sidebar {
      width: 60px;
    }

    .logo-text,
    .nav-label {
      display: none;
    }

    .logo {
      justify-content: center;
      padding: 0 10px 20px;
    }

    .nav-link {
      justify-content: center;
      padding: 12px;
    }

    .main-content {
      margin-left: 60px;
    }

    .chat-float {
      bottom: 16px;
      right: 16px;
    }
  }
</style>
