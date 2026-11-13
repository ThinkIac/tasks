<script>
  import { onMount, tick } from 'svelte';
  import { parseTaskSource } from './lib/message-widget.js';

  let theme = 'dark';
  let loading = true;
  let error = '';
  let items = [];
  let resizeObserver;
  let widgetEl;

  function post(type, detail) {
    parent.postMessage({ source: 'aurora', type, detail }, '*');
  }

  async function reportHeight() {
    await tick();
    // The iframe starts at the host's provisional height. Measuring the
    // document therefore preserves that empty space; measure only our
    // intrinsic card instead.
    post('widget:height', Math.ceil(widgetEl?.getBoundingClientRect().height || 1));
  }

  function readSource() {
    const params = new URLSearchParams(location.hash.slice(1));
    const encoded = params.get('data');
    if (!encoded) throw new Error('Task payload is missing.');
    const payload = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    return payload?.source;
  }

  async function request(path) {
    const response = await fetch(`/tasks${path}`);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
    return data;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const ids = parseTaskSource(readSource());
      const [boards, columns, ...tasks] = await Promise.all([
        request('/boards'),
        request('/columns'),
        ...ids.map(async id => {
          try {
            return await request(`/tasks/${encodeURIComponent(id)}`);
          } catch (cause) {
            return { id, missing: true, error: cause.message };
          }
        }),
      ]);
      const boardNames = new Map(boards.map(board => [board.id, board.name]));
      const columnNames = new Map(columns.map(column => [column.id, column.name]));
      items = tasks.map(task => ({
        ...task,
        boardName: boardNames.get(task.boardId) || 'Unavailable board',
        columnName: columnNames.get(task.columnId) || 'Unavailable column',
      }));
    } catch (cause) {
      error = cause?.message || 'Unable to load tasks.';
      items = [];
    } finally {
      loading = false;
      reportHeight();
    }
  }

  function openTask(task) {
    if (task.missing) return;
    post('open:app', `/view/tasks/Index?taskId=${encodeURIComponent(task.id)}`);
  }

  function priorityLabel(priority) {
    return ({ low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' })[priority] || priority || 'Medium';
  }

  function dueLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }).format(date);
  }

  function tagsOf(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return String(value).split(',').map(tag => tag.trim()).filter(Boolean);
    }
  }

  function syncTheme() {
    theme = localStorage.getItem('think:theme') === 'light' ? 'light' : 'dark';
  }

  function onStorage(event) {
    if (event.key === 'think:theme') syncTheme();
  }

  onMount(() => {
    syncTheme();
    load();
    window.addEventListener('storage', onStorage);
    window.addEventListener('hashchange', load);
    resizeObserver = new ResizeObserver(reportHeight);
    resizeObserver.observe(widgetEl);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('hashchange', load);
      resizeObserver?.disconnect();
    };
  });
</script>

<svelte:head>
  <title>Tasks</title>
</svelte:head>

<div bind:this={widgetEl} class="widget" data-theme={theme} aria-busy={loading}>
  {#if loading}
    <div class="state">Loading tasks…</div>
  {:else if error}
    <div class="state error">{error}</div>
  {:else}
    <header>
      <span>{items.length === 1 ? 'Task' : `${items.length} tasks`}</span>
      <span class="live">Live data</span>
    </header>
    <div class="list">
      {#each items as task (task.id)}
        {#if task.missing}
          <article class="card missing">
            <div>
              <strong>Task not found</strong>
              <small>{task.id}</small>
            </div>
          </article>
        {:else}
          <article class="card">
            <button class="content" on:click={() => openTask(task)} aria-label={`Open task ${task.title}`}>
              <span class="dot" class:urgent={task.priority === 'urgent'} class:high={task.priority === 'high'}></span>
              <span class="details">
                <strong>{task.title}</strong>
                <small>{task.boardName} · {task.columnName}</small>
                <span class="meta">
                  <span>{priorityLabel(task.priority)}</span>
                  {#if task.dueDate}<span>{dueLabel(task.dueDate)}</span>{/if}
                  {#each tagsOf(task.tags).slice(0, 3) as tag}<span class="tag">{tag}</span>{/each}
                </span>
              </span>
              <span class="open" aria-hidden="true">
                Open
                <svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" /></svg>
              </span>
            </button>
          </article>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body) { margin: 0; background: transparent; }
  .widget[data-theme='dark'] {
    --tk-bg: #111111; --tk-surface: #181818; --tk-surface-2: #1f1f1f;
    --tk-border: rgba(255,255,255,.09); --tk-border-hi: rgba(255,255,255,.16);
    --tk-text: #f5f5f5; --tk-muted: #888888; --tk-muted-2: rgba(136,136,136,.5);
    --tk-accent: #f5f5f5; --tk-on-accent: #111111;
  }
  .widget[data-theme='light'] {
    --tk-bg: #ffffff; --tk-surface: #f5f5f5; --tk-surface-2: #ececec;
    --tk-border: rgba(0,0,0,.10); --tk-border-hi: rgba(0,0,0,.18);
    --tk-text: #1a1a1a; --tk-muted: #666666; --tk-muted-2: rgba(0,0,0,.4);
    --tk-accent: #111111; --tk-on-accent: #ffffff;
  }
  .widget {
    --tk-radius-md: 8px; --tk-radius-lg: 14px;
    --tk-font: 'Ubuntu', system-ui, sans-serif; --tk-mono: 'Ubuntu Mono', monospace;
    box-sizing: border-box; width: 100%; padding: 8px; color: var(--tk-text);
    font-family: var(--tk-font); background: transparent; border: 0;
  }
  header { display: flex; justify-content: space-between; padding: 4px 6px 10px; font-size: 13px; font-weight: 500; }
  .live { color: var(--tk-muted); font-size: 11px; font-weight: 400; }
  .list { display: grid; gap: 5px; }
  .card { overflow: hidden; background: var(--tk-surface); border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md); }
  .content { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; padding: 11px 12px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
  .content:hover { background: var(--tk-surface-2); }
  .content:focus-visible { outline: 1px solid var(--tk-accent); outline-offset: -2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tk-muted); }
  .dot.high { background: var(--tk-text); opacity: .7; }
  .dot.urgent { background: var(--tk-accent); outline: 2px solid var(--tk-border-hi); }
  .details { min-width: 0; display: grid; gap: 3px; }
  strong { overflow: hidden; color: var(--tk-text); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  small { overflow: hidden; color: var(--tk-muted); font-family: var(--tk-mono); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; flex-wrap: wrap; gap: 5px; color: var(--tk-muted); font-size: 10px; }
  .meta > span { padding-right: 5px; border-right: 1px solid var(--tk-border); }
  .meta > span:last-child { border-right: 0; }
  .tag { color: var(--tk-text); }
  .open { display: flex; gap: 3px; align-items: center; color: var(--tk-muted); font-size: 11px; }
  .open svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
  .missing { padding: 12px; opacity: .75; }
  .missing div { display: grid; gap: 3px; }
  .state { padding: 18px 12px; color: var(--tk-muted); font-size: 12px; text-align: center; }
  .error { color: var(--tk-text); }
  @media (max-width: 480px) { .open { font-size: 0; } .widget { padding: 6px; } }
</style>
