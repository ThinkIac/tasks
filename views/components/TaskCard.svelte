<script>
  import { stripMarkdown } from '../lib/markdown.js';
  import { parseTags } from '../lib/tags.js';

  export let task;
  export let onOpen = () => {};
  export let onDelete = () => {};
  export let onDragStart = () => {};
  export let onDragEnd = () => {};
  export let dragging = false;

  // Mover para outro board/coluna: os boards vêm do pai, as colunas de cada
  // board são carregadas sob demanda (loadColumns é cacheado lá em cima).
  export let boards = [];
  export let loadColumns = async () => [];
  export let onMove = () => {};

  let moveOpen = false;
  let expandedBoardId = '';
  let moveColumns = [];
  let loadingCols = false;
  let moveError = '';

  async function toggleMove() {
    moveOpen = !moveOpen;
    if (!moveOpen) return;
    moveError = '';
    await expandBoard(task.boardId);
  }

  async function expandBoard(boardId) {
    expandedBoardId = boardId;
    loadingCols = true;
    moveColumns = [];
    try { moveColumns = await loadColumns(boardId); }
    catch (e) { moveError = e.message; }
    finally { loadingCols = false; }
  }

  function pickColumn(column) {
    moveOpen = false;
    // Erro de movimentação é responsabilidade do pai (banner global).
    onMove(task, { boardId: expandedBoardId, columnId: column.id });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function isOverdue(iso) {
    return iso ? new Date(iso) < new Date() : false;
  }

  const priorityLabel = { low: 'Baixa', medium: 'Média', high: 'Alta', urgent: 'Urgente' };

  $: tags = parseTags(task.tags);

  function handleDragStart(event) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    onDragStart(task, event);
  }
</script>

<svelte:window on:click={() => (moveOpen = false)} />

<div
  class="card pri-{task.priority}"
  class:dragging
  role="button"
  tabindex="0"
  draggable="true"
  on:dragstart={handleDragStart}
  on:dragend={onDragEnd}
  on:click={() => onOpen(task)}
  on:keydown={(e) => { if (e.key === 'Enter') onOpen(task); }}
>
  <div class="card-top">
    <span class="card-pri-dot pri-dot-{task.priority}" title={priorityLabel[task.priority] || task.priority}></span>
    <div class="card-title">{task.title}</div>
    <button class="card-act" title="Mover para outro board/coluna" aria-label="Mover tarefa" on:click|stopPropagation={toggleMove}>
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M1 4.5h9M7.5 2 10 4.5 7.5 7M13 9.5H4M6.5 7 4 9.5 6.5 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="card-act card-del" title="Excluir" aria-label="Excluir tarefa" on:click|stopPropagation={() => onDelete(task.id)}>
      <svg width="11" height="11" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
  </div>

  {#if moveOpen}
    <div class="move-pop" role="dialog" on:click|stopPropagation on:keydown|stopPropagation>
      <span class="move-label">Board</span>
      <div class="move-boards">
        {#each boards as b (b.id)}
          <button
            class="move-board"
            class:active={b.id === expandedBoardId}
            on:click={() => expandBoard(b.id)}
          >{b.name}</button>
        {/each}
      </div>
      <span class="move-label">Coluna</span>
      {#if loadingCols}
        <div class="move-hint">Carregando…</div>
      {:else if moveError}
        <div class="move-hint move-hint-error">{moveError}</div>
      {:else if moveColumns.length === 0}
        <div class="move-hint">Este board não tem colunas.</div>
      {:else}
        <div class="move-cols">
          {#each moveColumns as c (c.id)}
            <button
              class="move-col"
              style="--c: {c.color}"
              disabled={c.id === task.columnId && expandedBoardId === task.boardId}
              on:click={() => pickColumn(c)}
            >{c.name}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if task.description && task.description.length > 3}
    <!-- No card a descrição é só um resumo: markdown vira texto limpo (a
         renderização rica acontece no modal). -->
    <div class="card-desc">{stripMarkdown(task.description, 100)}</div>
  {/if}

  {#if task.dueDate || tags.length}
    <div class="card-footer">
      {#if task.dueDate}
        <span class="card-due" class:overdue={isOverdue(task.dueDate)}>
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 6h10M5 2v2M9 2v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          {formatDate(task.dueDate)}
        </span>
      {/if}
      <div class="card-tags">
        {#each tags as tag}<span class="card-tag">{tag}</span>{/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--tk-surface-2);
    border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-md);
    padding: 9px 10px;
    cursor: pointer;
    margin-bottom: 6px;
    transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s, opacity 0.15s;
    border-left: 3px solid transparent;
  }
  .card:last-child { margin-bottom: 0; }
  .card:hover, .card:focus-visible {
    border-color: var(--tk-border-hi);
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    transform: translateY(-1px);
    outline: none;
  }
  .card.dragging { opacity: 0.4; transform: scale(0.98); }

  .card.pri-urgent { border-left-color: #f43f5e; }
  .card.pri-high   { border-left-color: #f97316; }
  .card.pri-medium { border-left-color: #3b82f6; }
  .card.pri-low    { border-left-color: var(--tk-muted-2); }

  .card-top { display: flex; align-items: flex-start; gap: 6px; }
  .card-pri-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
  .pri-dot-urgent { background: #f43f5e; }
  .pri-dot-high   { background: #f97316; }
  .pri-dot-medium { background: #3b82f6; }
  .pri-dot-low    { background: var(--tk-muted-2); }

  .card-title { flex: 1; font-size: 13px; font-weight: 500; color: var(--tk-text); line-height: 1.4; }

  .card-act {
    width: 20px; height: 20px; border: none; background: none;
    color: var(--tk-muted-2); cursor: pointer; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s;
  }
  .card:hover .card-act, .card:focus-within .card-act { opacity: 1; }
  .card-act:hover { background: var(--tk-surface); color: var(--tk-text); }
  .card-del:hover { background: rgba(244,63,94,0.1); color: #f43f5e; }
  /* Em telas sem hover (touch) as ações precisam ficar sempre visíveis/tocáveis. */
  @media (hover: none) {
    .card-act { opacity: 1; }
  }

  /* Painel "mover": inline (não absoluto) para não ser cortado pelo scroll da
     coluna nos três layouts. */
  .move-pop {
    margin-top: 8px; padding: 8px;
    background: var(--tk-surface); border: 1px solid var(--tk-border-hi);
    border-radius: var(--tk-radius-md);
    display: flex; flex-direction: column; gap: 4px; cursor: default;
  }
  .move-label {
    font-size: 9px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--tk-muted-2);
  }
  .move-boards, .move-cols { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .move-board, .move-col {
    height: 24px; padding: 0 9px; border-radius: 12px; max-width: 100%;
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    color: var(--tk-muted); font-size: 11px; font-family: inherit; cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: border-color 0.12s, color 0.12s;
  }
  .move-board:hover, .move-col:hover { border-color: var(--tk-border-hi); color: var(--tk-text); }
  .move-board.active { border-color: var(--tk-border-hi); color: var(--tk-text); font-weight: 600; }
  .move-col { display: inline-flex; align-items: center; gap: 5px; }
  .move-col::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--c); flex-shrink: 0; }
  .move-col:disabled { opacity: 0.4; cursor: default; }
  .move-hint { font-size: 11px; color: var(--tk-muted-2); padding: 2px 0 4px; }
  .move-hint-error { color: #f43f5e; }

  .card-desc {
    font-size: 11.5px; color: var(--tk-muted); line-height: 1.45;
    margin-top: 5px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .card-footer { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .card-due { display: flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--tk-muted-2); }
  .card-due.overdue { color: #f43f5e; }

  .card-tags { display: flex; gap: 3px; flex-wrap: wrap; }
  .card-tag {
    font-size: 9.5px; font-weight: 500; color: var(--tk-muted);
    background: var(--tk-surface); border: 1px solid var(--tk-border);
    padding: 1px 6px; border-radius: 4px;
  }
</style>
