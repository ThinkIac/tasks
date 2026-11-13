<script>
  import TaskCard from './TaskCard.svelte';

  export let column;
  export let tasks = [];
  export let mode = 'board'; // 'board' | 'list' | 'focus'
  export let otherColumns = [];
  export let draggingTaskId = null;
  export let onKind = () => {};

  // kind: 'open' | 'done' | 'cancelled' — done/cancelled são terminais.
  $: kind = ['done', 'cancelled'].includes(column.kind) ? column.kind : 'open';

  export let onOpenTask = () => {};
  export let onDeleteTask = () => {};
  export let onAddTask = () => {};
  export let onRename = () => {};
  export let onColor = () => {};
  export let onToggleClosed = () => {};
  export let onDeleteColumn = () => {};
  export let onDragStartTask = () => {};
  export let onDragEndTask = () => {};
  export let onDrop = () => {};

  // "Mover para outro board" — repassado ao card.
  export let boards = [];
  export let loadColumns = async () => [];
  export let onMoveTask = () => {};


  const PALETTE = ['#94a3b8', '#f472b6', '#a78bfa', '#38bdf8', '#2dd4bf', '#facc15', '#fb923c', '#f87171', '#64748b'];

  let editingName = false;
  let nameDraft = column.name;
  let menuOpen = false;
  let colorOpen = false;
  let confirmDelete = false;
  let moveToId = otherColumns[0]?.id || '';
  let addingTask = false;
  let newTitle = '';

  let overIndex = null;
  let isOver = false;
  let adding = false;

  // Só sincroniza o rascunho com o nome vindo do prop quando NÃO se está
  // editando — senão qualquer re-render do pai (que recria os objetos de
  // coluna) apagaria o texto sendo digitado.
  $: if (!editingName) nameDraft = column.name;
  $: moveToId = otherColumns[0]?.id || '';

  function commitName() {
    editingName = false;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== column.name) onRename(trimmed);
    else nameDraft = column.name;
  }

  async function submitAdd() {
    const title = newTitle.trim();
    if (!title) { addingTask = false; return; }
    if (adding) return; // evita duplicar em Enter repetido / eventos sintéticos
    adding = true;
    newTitle = '';
    try { await onAddTask(title); } finally { adding = false; }
  }

  function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    isOver = true;
    const container = event.currentTarget;
    const cardEls = Array.from(container.querySelectorAll(':scope > .card'));
    let idx = cardEls.length;
    for (let i = 0; i < cardEls.length; i++) {
      const rect = cardEls[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) { idx = i; break; }
    }
    overIndex = idx;
  }
  function handleDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) { isOver = false; overIndex = null; }
  }
  function handleDrop(event) {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain');
    isOver = false;
    const at = overIndex;
    overIndex = null;
    if (!draggedId) return;
    const ids = tasks.map(t => t.id).filter(id => id !== draggedId);
    const insertAt = at === null ? ids.length : Math.min(at, ids.length);
    ids.splice(insertAt, 0, draggedId);
    onDrop(column.id, ids);
  }

  function requestDelete() {
    if (tasks.length === 0) { onDeleteColumn(null); return; }
    confirmDelete = true;
    menuOpen = false;
  }
</script>

<svelte:window on:click={() => { menuOpen = false; colorOpen = false; }} />

{#if column.closed}
  <button class="col-closed" style="--c: {column.color}" on:click={() => onToggleClosed(false)} title="Reabrir coluna">
    <span class="col-closed-label">{column.name}</span>
    <span class="col-closed-count">{tasks.length}</span>
  </button>
{:else}
  <div class="col" data-mode={mode} class:col-drop-active={isOver}>
    <div class="col-header">
      <button class="col-dot" style="--c: {column.color}" title="Cor da coluna" on:click|stopPropagation={() => (colorOpen = !colorOpen)}></button>

      {#if colorOpen}
        <div class="color-pop" on:click|stopPropagation>
          {#each PALETTE as c}
            <button class="swatch" style="--c: {c}" aria-label={c} on:click={() => { onColor(c); colorOpen = false; }}></button>
          {/each}
        </div>
      {/if}

      {#if editingName}
        <input
          class="col-name-input"
          bind:value={nameDraft}
          on:blur={commitName}
          on:keydown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { nameDraft = column.name; editingName = false; } }}
          autofocus
        />
      {:else}
        <button class="col-name" on:click={() => (editingName = true)} title="Renomear coluna">{column.name}</button>
      {/if}

      {#if kind === 'done'}
        <span class="col-kind col-kind-done" title="Coluna de finalizado">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M1.5 6.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Done
        </span>
      {:else if kind === 'cancelled'}
        <span class="col-kind col-kind-cancelled" title="Coluna de cancelado">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          Cancelled
        </span>
      {/if}

      <span class="col-badge">{tasks.length}</span>

      <div class="col-menu-wrap">
        <button class="col-menu-btn" on:click|stopPropagation={() => (menuOpen = !menuOpen)} title="Opções da coluna" aria-label="Opções da coluna">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="3.5" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.5" r="1.3" fill="currentColor"/></svg>
        </button>
        {#if menuOpen}
          <div class="col-menu" on:click|stopPropagation>
            <span class="col-menu-label">Tipo da coluna</span>
            <button class:checked={kind === 'open'} on:click={() => { onKind('open'); menuOpen = false; }}>
              Normal {#if kind === 'open'}<span class="check">✓</span>{/if}
            </button>
            <button class:checked={kind === 'done'} on:click={() => { onKind('done'); menuOpen = false; }}>
              Done (finalizado) {#if kind === 'done'}<span class="check">✓</span>{/if}
            </button>
            <button class:checked={kind === 'cancelled'} on:click={() => { onKind('cancelled'); menuOpen = false; }}>
              Cancelled (cancelado) {#if kind === 'cancelled'}<span class="check">✓</span>{/if}
            </button>
            <div class="col-menu-sep"></div>
            <button on:click={() => { onToggleClosed(true); menuOpen = false; }}>Ocultar coluna</button>
            <button class="danger" on:click={requestDelete}>Excluir coluna</button>
          </div>
        {/if}
      </div>
    </div>

    {#if confirmDelete}
      <div class="confirm-delete">
        <p>Mover {tasks.length} tarefa{tasks.length === 1 ? '' : 's'} para:</p>
        {#if otherColumns.length}
          <select bind:value={moveToId}>
            {#each otherColumns as c}<option value={c.id}>{c.name}</option>{/each}
          </select>
          <div class="confirm-actions">
            <button on:click={() => (confirmDelete = false)}>Cancelar</button>
            <button class="danger" on:click={() => { onDeleteColumn(moveToId); confirmDelete = false; }}>Excluir</button>
          </div>
        {:else}
          <p class="confirm-warning">Não há outra coluna para receber as tarefas.</p>
          <div class="confirm-actions">
            <button on:click={() => (confirmDelete = false)}>Cancelar</button>
          </div>
        {/if}
      </div>
    {/if}

    <div
      class="col-body"
      role="list"
      on:dragover={handleDragOver}
      on:dragleave={handleDragLeave}
      on:drop={handleDrop}
    >
      {#each tasks as task (task.id)}
        <TaskCard
          {task}
          dragging={draggingTaskId === task.id}
          onOpen={onOpenTask}
          onDelete={onDeleteTask}
          onDragStart={(t, e) => onDragStartTask(t, e)}
          onDragEnd={onDragEndTask}
          {boards}
          {loadColumns}
          onMove={onMoveTask}
        />
      {/each}
      {#if tasks.length === 0}
        <div class="col-empty">Sem tarefas</div>
      {/if}
    </div>

    <div class="col-add">
      {#if addingTask}
        <input
          class="col-add-input"
          placeholder="Título da tarefa…"
          bind:value={newTitle}
          on:keydown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') { addingTask = false; newTitle = ''; } }}
          on:blur={() => { if (!newTitle.trim()) addingTask = false; }}
          autofocus
        />
      {:else}
        <button class="col-add-btn" on:click={() => (addingTask = true)}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          Adicionar tarefa
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .col {
    display: flex; flex-direction: column;
    background: var(--tk-surface); border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-lg); overflow: hidden;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .col[data-mode="board"] { width: 278px; flex-shrink: 0; height: 100%; }
  .col[data-mode="list"] { width: 100%; max-height: 420px; }
  .col[data-mode="focus"] { width: 100%; height: 100%; }

  .col.col-drop-active { border-color: var(--tk-accent); box-shadow: 0 0 0 2px var(--tk-accent-dim, rgba(0,0,0,0.08)); }

  .col-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 10px 10px 12px;
    border-bottom: 1px solid var(--tk-border);
    position: relative; flex-shrink: 0;
  }
  .col-dot {
    width: 10px; height: 10px; border-radius: 50%; background: var(--c);
    border: none; cursor: pointer; flex-shrink: 0; padding: 0;
  }
  .col-name {
    flex: 1; text-align: left; background: none; border: none; cursor: text;
    font-size: 12.5px; font-weight: 600; color: var(--tk-text); font-family: inherit;
    padding: 2px 4px; border-radius: 4px; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .col-name:hover { background: var(--tk-surface-2); }
  .col-name-input {
    flex: 1; font-size: 12.5px; font-weight: 600; color: var(--tk-text); font-family: inherit;
    background: var(--tk-surface-2); border: 1px solid var(--tk-border-hi); border-radius: 4px;
    padding: 2px 6px; outline: none; min-width: 0;
  }
  .col-badge {
    font-size: 10.5px; font-weight: 600; color: var(--tk-muted);
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    padding: 1px 7px; border-radius: 8px; flex-shrink: 0;
  }
  .col-kind {
    display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0;
    font-size: 9.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    padding: 1px 6px; border-radius: 8px;
  }
  .col-kind-done { color: #2dd4bf; background: rgba(45, 212, 191, 0.12); border: 1px solid rgba(45, 212, 191, 0.28); }
  .col-kind-cancelled { color: var(--tk-muted); background: var(--tk-surface-2); border: 1px solid var(--tk-border); }

  .col-menu-label {
    padding: 8px 12px 4px; font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--tk-muted-2);
  }
  .col-menu-sep { height: 1px; background: var(--tk-border); margin: 4px 0; }
  .col-menu button.checked { font-weight: 600; }
  .col-menu .check { color: #2dd4bf; margin-left: 4px; }

  .col-menu-wrap { position: relative; flex-shrink: 0; }
  .col-menu-btn {
    width: 24px; height: 24px; border: none; background: none; color: var(--tk-muted);
    cursor: pointer; border-radius: 5px; display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .col-menu-btn:hover { background: var(--tk-surface-2); color: var(--tk-text); }
  .col-menu {
    position: absolute; top: 28px; right: 0; z-index: 20;
    background: var(--tk-surface); border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    display: flex; flex-direction: column; min-width: 150px; overflow: hidden;
  }
  .col-menu button {
    text-align: left; padding: 8px 12px; background: none; border: none;
    font-size: 12.5px; color: var(--tk-text); cursor: pointer; font-family: inherit;
  }
  .col-menu button:hover { background: var(--tk-surface-2); }
  .col-menu button.danger { color: #f43f5e; }

  .color-pop {
    position: absolute; top: 28px; left: 10px; z-index: 20;
    background: var(--tk-surface); border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    padding: 8px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
  }
  .swatch { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2px solid transparent; cursor: pointer; padding: 0; }
  .swatch:hover { border-color: var(--tk-border-hi); }

  .confirm-delete {
    padding: 10px 12px; background: rgba(244,63,94,0.05); border-bottom: 1px solid var(--tk-border);
    font-size: 12px; color: var(--tk-text); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
  }
  .confirm-delete select {
    height: 30px; border-radius: var(--tk-radius-md); border: 1px solid var(--tk-border); background: var(--tk-surface-2);
    color: var(--tk-text); font-family: inherit; font-size: 12px; padding: 0 8px;
  }
  .confirm-warning { color: #f43f5e; }
  .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .confirm-actions button {
    height: 28px; padding: 0 12px; border-radius: var(--tk-radius-md); border: 1px solid var(--tk-border);
    background: var(--tk-surface-2); color: var(--tk-text); font-size: 12px; font-family: inherit; cursor: pointer;
  }
  .confirm-actions button.danger { background: rgba(244,63,94,0.1); border-color: rgba(244,63,94,0.3); color: #f43f5e; }

  .col-body {
    flex: 1; overflow-y: auto; padding: 8px;
    scrollbar-width: thin; scrollbar-color: var(--tk-border) transparent;
  }
  .col[data-mode="list"] .col-body { flex: none; }
  .col-body::-webkit-scrollbar { width: 4px; }
  .col-body::-webkit-scrollbar-thumb { background: var(--tk-border); border-radius: 2px; }

  .col-empty {
    text-align: center; color: var(--tk-muted-2); font-size: 12px; padding: 22px 8px;
    border: 1.5px dashed var(--tk-border); border-radius: var(--tk-radius-md);
  }

  .col-add { padding: 6px 8px 8px; flex-shrink: 0; }
  .col-add-btn {
    width: 100%; display: flex; align-items: center; gap: 6px; justify-content: center;
    height: 32px; border-radius: var(--tk-radius-md); border: 1px dashed var(--tk-border);
    background: none; color: var(--tk-muted); font-size: 12px; font-family: inherit; cursor: pointer;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .col-add-btn:hover { border-color: var(--tk-border-hi); color: var(--tk-text); background: var(--tk-surface-2); }
  .col-add-input {
    width: 100%; height: 32px; border-radius: var(--tk-radius-md); border: 1px solid var(--tk-border-hi);
    background: var(--tk-surface-2); color: var(--tk-text); font-size: 12.5px; font-family: inherit;
    padding: 0 10px; outline: none;
  }

  .col-closed {
    width: 40px; flex-shrink: 0; height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 10px;
    padding: 12px 0; background: var(--tk-surface); border: 1px solid var(--tk-border); border-radius: var(--tk-radius-lg);
    cursor: pointer; font-family: inherit;
    border-top: 3px solid var(--c);
  }
  .col-closed-label {
    writing-mode: vertical-rl; transform: rotate(180deg);
    font-size: 12px; font-weight: 600; color: var(--tk-text); white-space: nowrap;
  }
  .col-closed-count {
    font-size: 10px; font-weight: 600; color: var(--tk-muted);
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    padding: 1px 6px; border-radius: 8px;
  }
</style>
