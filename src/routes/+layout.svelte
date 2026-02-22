<script lang="ts">
  import '../app.css';
  import favicon from '$lib/assets/favicon.svg';

  interface Props {
    children: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  const navItems = [
    { href: '/', label: 'Dashboard', icon: '📊' },
    { href: '/crawl', label: 'Crawl', icon: '🌐' },
    { href: '/knowledge', label: 'Knowledge', icon: '📚' },
    { href: '/evaluate', label: 'Evaluate', icon: '📈' },
    { href: '/quality', label: 'Quality', icon: '🎯' },
  ];
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
          <a href={item.href} class="nav-link">
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

  .nav-link:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #fff;
    text-decoration: none;
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

  @media (max-width: 768px) {
    .sidebar {
      width: 60px;
    }

    .logo-text, .nav-label, .pipeline-legend {
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
  }
</style>
