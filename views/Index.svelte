<script>
  import { onMount, onDestroy } from 'svelte';
  import { getTheme, onThemeChange } from './lib/theme.js';
  import { parseTags } from './lib/tags.js';
  import * as api from './lib/api.js';
  import ColumnView from './components/ColumnView.svelte';
  import TaskModal from './components/TaskModal.svelte';
  import DailyPlanner from './components/DailyPlanner.svelte';

  const LAYOUT_KEY = 'tasks:layoutMode';

  let theme = getTheme();
  let offTheme;

  let boards = [];
  let activeBoardId = '';
  let columns = [];
  let tasks = [];
  let loading = true;
  let error = '';

  let layoutMode = 'board';
  let focusIndex = 0;

  let searchQuery = '';
  let filterPriority = '';
  let filterTag = '';

  let editingTask = null;
  let draggingTaskId = null;

  // Stream ao vivo
  let stream = null;
  let live = false;
  let streamTimer = null;

  let editingBoardId = null;
  let boardNameDraft = '';
  let addingBoard = false;
  let newBoardName = '';
  let savingBoard = false;
  let pendingDeleteBoard = null;

  let addingColumn = false;
  let newColumnName = '';
  let savingColumn = false;

  let touchStartX = null;

  // Só toca window/localStorage dentro do onMount (evita quebrar no SSR).
  function detectDefaultLayout() {
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) return saved;
    } catch {}
    try {
      if (window.matchMedia('(max-width: 768px)').matches) return 'focus';
    } catch {}
    return 'board';
  }

  function setLayoutMode(mode) {
    layoutMode = mode;
    try { localStorage.setItem(LAYOUT_KEY, mode); } catch {}
  }

  $: activeBoard = boards.find(b => b.id === activeBoardId);

  $: filteredTasks = tasks.filter(t => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const inTitle = t.title?.toLowerCase().includes(q);
      const inDesc = t.description?.toLowerCase().includes(q);
      if (!inTitle && !inDesc) return false;
    }
    if (filterPriority && t.priority !== filterPriority) return false;
    if (filterTag && !parseTags(t.tags).includes(filterTag)) return false;
    return true;
  });

  $: allTags = [...new Set(tasks.flatMap(t => parseTags(t.tags)))].filter(Boolean).sort((a, b) => a.localeCompare(b));

  $: openColumns = [...columns].filter(c => !c.closed).sort((a, b) => a.order - b.order);
  $: closedColumns = [...columns].filter(c => c.closed).sort((a, b) => a.order - b.order);
  $: tasksByColumn = colId => filteredTasks.filter(t => t.columnId === colId).sort((a, b) => a.order - b.order);
  $: if (focusIndex >= openColumns.length) focusIndex = Math.max(0, openColumns.length - 1);

  async function loadBoards() {
    boards = await api.listBoards();
    if (!activeBoardId && boards.length) activeBoardId = boards[0].id;
  }

  async function loadBoardData({ silent = false } = {}) {
    if (!activeBoardId) { columns = []; tasks = []; return; }
    // Recarga vinda do stream não pisca a tela: mantém o board renderizado.
    if (!silent) loading = true;
    error = '';
    try {
      [columns, tasks] = await Promise.all([
        api.listColumns(activeBoardId),
        api.listTasks(activeBoardId),
      ]);
      // O board ativo acabou de ser relido — mantém o cache do seletor de
      // destino em dia (colunas criadas/renomeadas/excluídas aqui).
      columnsCache = { ...columnsCache, [activeBoardId]: columns };
    } catch (e) { error = e.message; }
    finally { loading = false; }
  }

  /* ───────── Mover tasks entre boards/colunas ─────────
   * As colunas dos outros boards só são buscadas quando o usuário abre o
   * seletor de destino num card, e ficam em cache por board.
   */
  let columnsCache = {};

  async function loadColumnsFor(boardId) {
    if (!boardId) return [];
    if (columnsCache[boardId]) return columnsCache[boardId];
    const cols = await api.listColumns(boardId);
    columnsCache = { ...columnsCache, [boardId]: cols };
    return cols;
  }

  // target: { boardId, columnId? } — sem columnId o backend escolhe a primeira
  // coluna aberta do board (caminho do arrastar-para-a-aba).
  async function moveTaskTo(task, target) {
    if (target.boardId === activeBoardId && (!target.columnId || target.columnId === task.columnId)) return;
    // Eco otimista: some da visão se foi para outro board, senão troca de coluna.
    const leaving = target.boardId !== activeBoardId;
    const previous = tasks;
    tasks = leaving
      ? tasks.filter(t => t.id !== task.id)
      : tasks.map(t => (t.id === task.id ? { ...t, columnId: target.columnId } : t));
    try {
      await api.moveTask(task.id, target);
      // Os orders da origem e do destino foram reindexados no servidor.
      if (!leaving) tasks = await api.listTasks(activeBoardId);
    } catch (e) {
      error = e.message;
      tasks = previous;
    }
  }

  /* ───────── Stream ao vivo ─────────
   * Qualquer mudança no board — desta aba, de outra, de uma tool do assistente
   * chega por SSE. A recarga é agrupada num debounce curto.
   * Enquanto o usuário arrasta um card, a recarga espera — senão o servidor
   * reescreveria a lista embaixo do dedo dele.
   */
  function scheduleRefresh() {
    clearTimeout(streamTimer);
    streamTimer = setTimeout(async () => {
      if (draggingTaskId) { scheduleRefresh(); return; }
      await loadBoardData({ silent: true }).catch(() => {});
      // Um card aberto também é "ao vivo": trocar a referência faz o modal
      // remontar e reler comentários. Só quando algo mudou de fato —
      // remontar a cada evento descartaria o que estivesse sendo digitado.
      const id = editingTask?.id;
      if (!id) return;
      const fresh = tasks.find(t => t.id === id);
      if (fresh && fresh.updatedAt !== editingTask.updatedAt) editingTask = fresh;
    }, 250);
  }

  function connectStream() {
    if (typeof EventSource === 'undefined') return;
    stream = new EventSource(api.eventsUrl());
    stream.addEventListener('connected', () => (live = true));
    stream.onerror = () => { live = false; }; // o próprio EventSource reconecta
    // Sem listener por tipo: qualquer evento do board pede recarga.
    for (const name of [
      'tasks:created', 'tasks:updated', 'tasks:deleted', 'tasks:moved',
      'tasks:completed', 'tasks:cancelled', 'tasks:reopened', 'tasks:due',
      'tasks:comment_added', 'tasks:comment_deleted',
      'tasks:column_created', 'tasks:column_updated', 'tasks:column_deleted',
    ]) {
      stream.addEventListener(name, () => { live = true; scheduleRefresh(); });
    }
    for (const name of ['tasks:board_created', 'tasks:board_updated', 'tasks:board_deleted']) {
      stream.addEventListener(name, () => { live = true; loadBoards().catch(() => {}); scheduleRefresh(); });
    }
  }

  onMount(async () => {
    layoutMode = detectDefaultLayout();
    offTheme = onThemeChange(t => (theme = t));
    try {
      await loadBoards();
      const params = new URLSearchParams(window.location.search);
      const taskId = params.get('taskId');
      if (taskId) {
        const task = await api.getTask(taskId);
        if (task.boardId) activeBoardId = task.boardId;
        await loadBoardData();
        editingTask = tasks.find(item => item.id === taskId) || task;
      } else {
        await loadBoardData();
      }
      connectStream();
    } catch (e) {
      error = e.message;
      loading = false;
    }
  });
  onDestroy(() => {
    offTheme && offTheme();
    clearTimeout(streamTimer);
    stream?.close();
  });

  async function switchBoard(id) {
    if (id === activeBoardId) return;
    activeBoardId = id;
    focusIndex = 0;
    await loadBoardData();
  }

  async function submitNewBoard() {
    const name = newBoardName.trim();
    // Limpa o estado ANTES do await: se o input desmontar, o blur que dispara
    // em seguida reentra aqui com nome vazio e vira no-op (não cria 2 boards).
    newBoardName = '';
    addingBoard = false;
    if (!name || savingBoard) return;
    savingBoard = true;
    try {
      const board = await api.createBoard({ name });
      await loadBoards();
      await switchBoard(board.id);
    } catch (e) { error = e.message; }
    finally { savingBoard = false; }
  }

  function startRenameBoard(board) {
    editingBoardId = board.id;
    boardNameDraft = board.name;
  }
  async function commitRenameBoard() {
    const id = editingBoardId;
    const name = boardNameDraft.trim();
    editingBoardId = null;
    if (!id || !name) return;
    boards = boards.map(b => (b.id === id ? { ...b, name } : b));
    try { await api.updateBoard(id, { name }); } catch (e) { error = e.message; await loadBoards(); }
  }

  function requestDeleteBoard(board) {
    if (boards.length <= 1) { error = 'Não é possível excluir o último board'; return; }
    pendingDeleteBoard = board;
  }
  async function confirmDeleteBoard() {
    const board = pendingDeleteBoard;
    pendingDeleteBoard = null;
    if (!board) return;
    try {
      await api.deleteBoard(board.id);
      const { [board.id]: _gone, ...rest } = columnsCache;
      columnsCache = rest;
      const wasActive = activeBoardId === board.id;
      await loadBoards();
      if (wasActive) await switchBoard(boards[0]?.id);
    } catch (e) { error = e.message; }
  }

  function startAddColumn() { addingColumn = true; newColumnName = ''; }
  async function submitNewColumn() {
    const name = newColumnName.trim();
    // Mesmo padrão anti-duplicação do board: limpa antes do await.
    newColumnName = '';
    addingColumn = false;
    if (!name || savingColumn) return;
    savingColumn = true;
    try {
      await api.createColumn({ boardId: activeBoardId, name });
      await loadBoardData();
    } catch (e) { error = e.message; }
    finally { savingColumn = false; }
  }
  async function renameColumn(column, name) {
    columns = columns.map(c => (c.id === column.id ? { ...c, name } : c));
    try { await api.updateColumn(column.id, { name }); } catch (e) { error = e.message; await loadBoardData(); }
  }
  async function recolorColumn(column, color) {
    columns = columns.map(c => (c.id === column.id ? { ...c, color } : c));
    try { await api.updateColumn(column.id, { color }); } catch (e) { error = e.message; await loadBoardData(); }
  }
  async function setColumnKind(column, kind) {
    // Colunas terminais (done/cancelled) ficam fechadas por padrão — o backend
    // aplica a mesma regra, aqui é só o eco otimista.
    const closed = kind !== 'open';
    columns = columns.map(c => (c.id === column.id ? { ...c, kind, closed } : c));
    try { await api.updateColumn(column.id, { kind }); } catch (e) { error = e.message; await loadBoardData(); }
  }
  async function toggleColumnClosed(column, closed) {
    columns = columns.map(c => (c.id === column.id ? { ...c, closed } : c));
    try { await api.updateColumn(column.id, { closed }); } catch (e) { error = e.message; await loadBoardData(); }
  }
  async function removeColumn(column, moveToId) {
    try {
      await api.deleteColumn(column.id, moveToId);
      await loadBoardData();
    } catch (e) { error = e.message; }
  }

  async function addTask(column, title) {
    try {
      const task = await api.createTask({ boardId: activeBoardId, columnId: column.id, title });
      tasks = [...tasks, task];
    } catch (e) { error = e.message; }
  }
  async function addPlannerTask(title) {
    const column = openColumns[0];
    if (!column) { error = 'Crie uma coluna aberta antes de adicionar tarefas.'; return; }
    const dueDate = new Date();
    dueDate.setHours(9, 0, 0, 0);
    try {
      const task = await api.createTask({ boardId: activeBoardId, columnId: column.id, title, dueDate: dueDate.toISOString() });
      tasks = [...tasks, task];
    } catch (e) { error = e.message; }
  }
  function openTask(task) { editingTask = task; }
  function closeModal() { editingTask = null; }
  async function saveTask(changes) {
    const id = editingTask.id;
    try {
      const updated = await api.updateTask(id, changes);
      // Se a task foi movida para outro board, ela sai da visão atual.
      if (updated.boardId && updated.boardId !== activeBoardId) {
        tasks = tasks.filter(t => t.id !== id);
      } else {
        tasks = tasks.map(t => (t.id === id ? updated : t));
      }
      editingTask = null;
    } catch (e) { error = e.message; }
  }
  async function removeTask(id) {
    tasks = tasks.filter(t => t.id !== id);
    if (editingTask?.id === id) editingTask = null;
    try { await api.deleteTask(id); } catch (e) { error = e.message; await loadBoardData(); }
  }

  function handleDragStartTask(task) { draggingTaskId = task.id; }
  function handleDragEndTask() { draggingTaskId = null; dropBoardId = null; }

  /* Arrastar um card para a aba de outro board move a task para lá (primeira
   * coluna aberta do destino). Só aceita o drop enquanto um card está sendo
   * arrastado e a aba não é a do board atual.
   */
  let dropBoardId = null;

  function canDropOnBoard(boardId) {
    return !!draggingTaskId && boardId !== activeBoardId;
  }
  function handleBoardTabDragOver(event, boardId) {
    if (!canDropOnBoard(boardId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dropBoardId = boardId;
  }
  function handleBoardTabDragLeave(boardId) {
    if (dropBoardId === boardId) dropBoardId = null;
  }
  async function handleBoardTabDrop(event, boardId) {
    if (!canDropOnBoard(boardId)) return;
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain') || draggingTaskId;
    dropBoardId = null;
    draggingTaskId = null;
    const task = tasks.find(t => t.id === id);
    if (task) await moveTaskTo(task, { boardId });
  }

  async function handleColumnDrop(columnId, orderedIds) {
    draggingTaskId = null;
    const movedSet = new Set(orderedIds);
    const others = tasks.filter(t => !movedSet.has(t.id));
    const moved = orderedIds
      .map((id, index) => {
        const t = tasks.find(x => x.id === id);
        return t ? { ...t, columnId, order: index } : null;
      })
      .filter(Boolean);
    tasks = [...others, ...moved];
    try { await api.reorderTasks(columnId, orderedIds); } catch (e) { error = e.message; await loadBoardData(); }
  }

  function handleTouchStart(event) { touchStartX = event.touches[0].clientX; }
  function handleTouchEnd(event) {
    if (touchStartX === null) return;
    const dx = event.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 50) return;
    if (dx < 0 && focusIndex < openColumns.length - 1) focusIndex++;
    else if (dx > 0 && focusIndex > 0) focusIndex--;
  }
</script>

<div class="tasks-app" data-theme={theme}>
  <header class="topbar">
    <div class="board-tabs">
      {#each boards as board (board.id)}
        <div class="board-tab-wrap">
          {#if editingBoardId === board.id}
            <input
              class="board-tab-input"
              bind:value={boardNameDraft}
              on:blur={commitRenameBoard}
              on:keydown={(e) => { if (e.key === 'Enter') commitRenameBoard(); if (e.key === 'Escape') editingBoardId = null; }}
              autofocus
            />
          {:else}
            <button
              class="board-tab"
              class:active={board.id === activeBoardId}
              class:drop-target={dropBoardId === board.id}
              title={canDropOnBoard(board.id) ? `Soltar aqui move a tarefa para "${board.name}"` : board.name}
              on:click={() => switchBoard(board.id)}
              on:dblclick={() => startRenameBoard(board)}
              on:dragover={(e) => handleBoardTabDragOver(e, board.id)}
              on:dragleave={() => handleBoardTabDragLeave(board.id)}
              on:drop={(e) => handleBoardTabDrop(e, board.id)}
            >{board.name}</button>
            {#if board.id === activeBoardId}
              <button class="board-tab-action" title="Renomear board" aria-label="Renomear board" on:click={() => startRenameBoard(board)}>
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M9.5 1.5l3 3-7.5 7.5-3.5.5.5-3.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
              </button>
              <button class="board-tab-action" title="Excluir board" aria-label="Excluir board" on:click={() => requestDeleteBoard(board)}>
                <svg width="11" height="11" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
              </button>
            {/if}
          {/if}
        </div>
      {/each}

      {#if addingBoard}
        <input
          class="board-tab-input"
          placeholder="Nome do board"
          bind:value={newBoardName}
          on:keydown={(e) => { if (e.key === 'Enter') submitNewBoard(); if (e.key === 'Escape') { addingBoard = false; newBoardName = ''; } }}
          on:blur={submitNewBoard}
          autofocus
        />
      {:else}
        <button class="board-tab-add" on:click={() => (addingBoard = true)} title="Novo board" aria-label="Novo board">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      {/if}
    </div>

    <div class="toolbar">
      <span class="live-dot" class:on={live} title={live ? 'Board ao vivo — mudanças aparecem sozinhas' : 'Sem conexão ao vivo'}></span>
      <div class="search-box">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="search-icon"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input type="text" placeholder="Buscar tarefas…" bind:value={searchQuery} class="search-input" />
        {#if searchQuery}
          <button class="search-clear" on:click={() => (searchQuery = '')} aria-label="Limpar busca">
            <svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        {/if}
      </div>

      <select bind:value={filterPriority} class="filter-select">
        <option value="">Prioridade</option>
        <option value="urgent">Urgente</option>
        <option value="high">Alta</option>
        <option value="medium">Média</option>
        <option value="low">Baixa</option>
      </select>

      {#if allTags.length}
        <select bind:value={filterTag} class="filter-select">
          <option value="">Tag</option>
          {#each allTags as tag}<option value={tag}>{tag}</option>{/each}
        </select>
      {/if}

      <div class="layout-switch" role="group" aria-label="Layout do board">
        <button class:active={layoutMode === 'board'} on:click={() => setLayoutMode('board')} title="Quadro" aria-label="Layout quadro">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="4" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="6" y="2" width="4" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="11" y="2" width="4" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
        <button class:active={layoutMode === 'list'} on:click={() => setLayoutMode('list')} title="Lista" aria-label="Layout lista">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="7" width="14" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="12" width="14" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
        <button class:active={layoutMode === 'focus'} on:click={() => setLayoutMode('focus')} title="Foco" aria-label="Layout foco">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
        <button class:active={layoutMode === 'planner'} on:click={() => setLayoutMode('planner')} title="Meu dia" aria-label="Planejador diário">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 1.5v3M11 1.5v3M4.5 7h7M5 10h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
  </header>

  {#if error}
    <div class="error-banner">
      <span>{error}</span>
      <button on:click={() => (error = '')} aria-label="Fechar erro">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
  {/if}

  {#if pendingDeleteBoard}
    <div class="confirm-overlay" role="presentation" on:click={() => (pendingDeleteBoard = null)}>
      <div class="confirm-dialog" role="dialog" aria-modal="true" on:click|stopPropagation>
        <p class="confirm-title">Excluir o board “{pendingDeleteBoard.name}”?</p>
        <p class="confirm-sub">Todas as colunas e tarefas deste board serão removidas.</p>
        <div class="confirm-buttons">
          <button class="confirm-cancel" on:click={() => (pendingDeleteBoard = null)}>Cancelar</button>
          <button class="confirm-danger" on:click={confirmDeleteBoard}>Excluir</button>
        </div>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Carregando…</span>
    </div>
  {:else if !activeBoard}
    <div class="empty-state">Nenhum board ainda. Crie um para começar.</div>
  {:else if layoutMode === 'planner'}
    <DailyPlanner {tasks} {columns} {boards} {loadColumns} onOpenTask={openTask} onDeleteTask={removeTask} onMoveTask={moveTaskTo} onDragStartTask={handleDragStartTask} onDragEndTask={handleDragEndTask} onAddTask={addPlannerTask} />
  {:else if layoutMode === 'board'}
    <div class="board-scroll">
      <div class="board-row">
        {#each openColumns as column (column.id)}
          <ColumnView
            {column}
            mode="board"
            {boards}
            loadColumns={loadColumnsFor}
            onMoveTask={moveTaskTo}
            tasks={tasksByColumn(column.id)}
            otherColumns={columns.filter(c => c.id !== column.id)}
            {draggingTaskId}
            onOpenTask={openTask}
            onDeleteTask={removeTask}
            onAddTask={(title) => addTask(column, title)}
            onRename={(name) => renameColumn(column, name)}
            onColor={(color) => recolorColumn(column, color)}
            onToggleClosed={(closed) => toggleColumnClosed(column, closed)}
            onKind={(kind) => setColumnKind(column, kind)}
            onDeleteColumn={(moveTo) => removeColumn(column, moveTo)}
            onDragStartTask={handleDragStartTask}
            onDragEndTask={handleDragEndTask}
            onDrop={handleColumnDrop}
          />
        {/each}
        {#if addingColumn}
          <input
            class="add-column-input"
            placeholder="Nome da coluna"
            bind:value={newColumnName}
            on:keydown={(e) => { if (e.key === 'Enter') submitNewColumn(); if (e.key === 'Escape') { addingColumn = false; newColumnName = ''; } }}
            on:blur={submitNewColumn}
            autofocus
          />
        {:else}
          <button class="add-column-btn" on:click={startAddColumn}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            Nova coluna
          </button>
        {/if}
        {#each closedColumns as column (column.id)}
          <ColumnView {column} mode="board" tasks={[]} otherColumns={[]} onToggleClosed={(closed) => toggleColumnClosed(column, closed)} />
        {/each}
      </div>
    </div>
  {:else if layoutMode === 'list'}
    <div class="board-list">
      {#each openColumns as column (column.id)}
        <ColumnView
          {column}
          mode="list"
          {boards}
          loadColumns={loadColumnsFor}
          onMoveTask={moveTaskTo}
          tasks={tasksByColumn(column.id)}
          otherColumns={columns.filter(c => c.id !== column.id)}
          {draggingTaskId}
          onOpenTask={openTask}
          onDeleteTask={removeTask}
          onAddTask={(title) => addTask(column, title)}
          onRename={(name) => renameColumn(column, name)}
          onColor={(color) => recolorColumn(column, color)}
          onToggleClosed={(closed) => toggleColumnClosed(column, closed)}
          onKind={(kind) => setColumnKind(column, kind)}
          onDeleteColumn={(moveTo) => removeColumn(column, moveTo)}
          onDragStartTask={handleDragStartTask}
          onDragEndTask={handleDragEndTask}
          onDrop={handleColumnDrop}
        />
      {/each}
      {#if addingColumn}
        <input
          class="add-column-input add-column-input-block"
          placeholder="Nome da coluna"
          bind:value={newColumnName}
          on:keydown={(e) => { if (e.key === 'Enter') submitNewColumn(); if (e.key === 'Escape') { addingColumn = false; newColumnName = ''; } }}
          on:blur={submitNewColumn}
          autofocus
        />
      {:else}
        <button class="add-column-btn add-column-btn-block" on:click={startAddColumn}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          Nova coluna
        </button>
      {/if}
      {#if closedColumns.length}
        <div class="closed-row">
          {#each closedColumns as column (column.id)}
            <button class="closed-chip" style="--c: {column.color}" on:click={() => toggleColumnClosed(column, false)}>
              {column.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="focus-nav">
      {#if addingColumn}
        <input
          class="focus-column-input"
          placeholder="Nome da coluna"
          bind:value={newColumnName}
          on:keydown={(e) => { if (e.key === 'Enter') submitNewColumn(); if (e.key === 'Escape') { addingColumn = false; newColumnName = ''; } }}
          on:blur={submitNewColumn}
          autofocus
        />
      {:else}
        <!-- Mobile: selector no lugar das abas. Desktop: pills. -->
        <select class="focus-select" on:change={(e) => (focusIndex = +e.target.value)} aria-label="Coluna em foco">
          {#each openColumns as column, i (column.id)}
            <option value={i} selected={i === focusIndex}>{column.name} · {tasksByColumn(column.id).length}</option>
          {/each}
        </select>
        <div class="focus-tabs">
          {#each openColumns as column, i (column.id)}
            <button class="focus-pill" class:active={i === focusIndex} style="--c: {column.color}" on:click={() => (focusIndex = i)}>
              {column.name}
              <span class="focus-pill-count">{tasksByColumn(column.id).length}</span>
            </button>
          {/each}
        </div>
        <button class="focus-pill focus-pill-add" on:click={startAddColumn} title="Nova coluna" aria-label="Nova coluna">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      {/if}
    </div>
    {#if openColumns[focusIndex]}
      <div class="focus-body" on:touchstart={handleTouchStart} on:touchend={handleTouchEnd}>
        <ColumnView
          column={openColumns[focusIndex]}
          mode="focus"
          {boards}
          loadColumns={loadColumnsFor}
          onMoveTask={moveTaskTo}
          tasks={tasksByColumn(openColumns[focusIndex].id)}
          otherColumns={columns.filter(c => c.id !== openColumns[focusIndex].id)}
          {draggingTaskId}
          onOpenTask={openTask}
          onDeleteTask={removeTask}
          onAddTask={(title) => addTask(openColumns[focusIndex], title)}
          onRename={(name) => renameColumn(openColumns[focusIndex], name)}
          onColor={(color) => recolorColumn(openColumns[focusIndex], color)}
          onToggleClosed={(closed) => toggleColumnClosed(openColumns[focusIndex], closed)}
          onKind={(kind) => setColumnKind(openColumns[focusIndex], kind)}
          onDeleteColumn={(moveTo) => removeColumn(openColumns[focusIndex], moveTo)}
          onDragStartTask={handleDragStartTask}
          onDragEndTask={handleDragEndTask}
          onDrop={handleColumnDrop}
        />
      </div>
    {:else}
      <div class="empty-state">Nenhuma coluna aberta.</div>
    {/if}
    {#if closedColumns.length}
      <div class="closed-row closed-row-focus">
        {#each closedColumns as column (column.id)}
          <button class="closed-chip" style="--c: {column.color}" on:click={() => toggleColumnClosed(column, false)}>
            {column.name}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  {#if editingTask}
    <TaskModal task={editingTask} {columns} boardId={activeBoardId} onSave={saveTask} onDelete={removeTask} onClose={closeModal} />
  {/if}
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,300;0,400;0,500;0,700;1,400&family=Ubuntu+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  :global(html), :global(body) { margin: 0; padding: 0; }
  * { box-sizing: border-box; }

  .tasks-app {
    min-height: 100dvh;
    font-family: var(--tk-font);
    font-size: 13px;
    background: var(--tk-bg);
    color: var(--tk-text);
    display: flex;
    flex-direction: column;
  }

  .tasks-app[data-theme="dark"] {
    --tk-bg: #111111;
    --tk-surface: #181818;
    --tk-surface-2: #1f1f1f;
    --tk-border: rgba(255, 255, 255, 0.09);
    --tk-border-hi: rgba(255, 255, 255, 0.16);
    --tk-text: #f5f5f5;
    --tk-muted: #888888;
    --tk-muted-2: rgba(136, 136, 136, 0.5);
    --tk-accent: #f5f5f5;
    --tk-on-accent: #111111;
    --tk-accent-dim: rgba(255, 255, 255, 0.12);
    --tk-radius-md: 8px;
    --tk-radius-lg: 14px;
    --tk-font: 'Ubuntu', system-ui, sans-serif;
    --tk-mono: 'Ubuntu Mono', 'Fira Code', monospace;
  }
  .tasks-app[data-theme="light"] {
    --tk-bg: #ffffff;
    --tk-surface: #f5f5f5;
    --tk-surface-2: #ececec;
    --tk-border: rgba(0, 0, 0, 0.1);
    --tk-border-hi: rgba(0, 0, 0, 0.18);
    --tk-text: #1a1a1a;
    --tk-muted: #666666;
    --tk-muted-2: rgba(0, 0, 0, 0.4);
    --tk-accent: #111111;
    --tk-on-accent: #ffffff;
    --tk-accent-dim: rgba(0, 0, 0, 0.08);
    --tk-radius-md: 8px;
    --tk-radius-lg: 14px;
    --tk-font: 'Ubuntu', system-ui, sans-serif;
    --tk-mono: 'Ubuntu Mono', 'Fira Code', monospace;
  }

  /* ─── TOPBAR ─── */
  .topbar {
    display: flex; flex-direction: column; gap: 8px;
    padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
    border-bottom: 1px solid var(--tk-border);
    background: var(--tk-surface);
    position: sticky; top: 0; z-index: 50;
    flex-shrink: 0;
  }

  .board-tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .board-tabs::-webkit-scrollbar { display: none; }
  .board-tab-wrap { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .board-tab {
    height: 30px; padding: 0 12px; border-radius: var(--tk-radius-md);
    background: none; border: 1px solid transparent; color: var(--tk-muted);
    font-size: 12.5px; font-weight: 500; font-family: inherit; cursor: pointer;
    white-space: nowrap; transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .board-tab:hover { background: var(--tk-surface-2); color: var(--tk-text); }
  .board-tab.active { background: var(--tk-surface-2); border-color: var(--tk-border); color: var(--tk-text); font-weight: 600; }
  /* Card sendo arrastado por cima da aba: destino de "mover para outro board". */
  .board-tab.drop-target {
    border-color: var(--tk-accent); color: var(--tk-text);
    background: var(--tk-accent-dim); border-style: dashed;
  }
  .board-tab-input {
    height: 30px; padding: 0 10px; border-radius: var(--tk-radius-md);
    background: var(--tk-surface-2); border: 1px solid var(--tk-border-hi); color: var(--tk-text);
    font-size: 12.5px; font-family: inherit; outline: none; width: 140px;
  }
  .board-tab-action {
    width: 24px; height: 24px; border: none; background: none; color: var(--tk-muted-2);
    cursor: pointer; border-radius: 5px; display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .board-tab-action:hover { background: var(--tk-surface-2); color: var(--tk-text); }
  .board-tab-add {
    width: 28px; height: 28px; border: 1px dashed var(--tk-border); background: none; color: var(--tk-muted);
    border-radius: var(--tk-radius-md); cursor: pointer; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: border-color 0.12s, color 0.12s;
  }
  .board-tab-add:hover { border-color: var(--tk-border-hi); color: var(--tk-text); }

  .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  /* Pisca quando o stream está conectado: o board se atualiza sozinho. */
  .live-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--tk-muted-2); transition: background 0.2s;
  }
  .live-dot.on { background: var(--tk-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tk-accent) 20%, transparent); }

  .search-box {
    display: flex; align-items: center; gap: 6px;
    background: var(--tk-bg); border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-md); padding: 0 10px; height: 32px; min-width: 180px; flex: 1 1 180px;
  }
  .search-box:focus-within { border-color: var(--tk-border-hi); }
  .search-icon { color: var(--tk-muted-2); flex-shrink: 0; }
  .search-input { flex: 1; background: none; border: none; outline: none; color: var(--tk-text); font-size: 12.5px; font-family: inherit; min-width: 0; }
  .search-input::placeholder { color: var(--tk-muted-2); }
  .search-clear { background: none; border: none; color: var(--tk-muted-2); cursor: pointer; display: flex; padding: 2px; border-radius: 3px; }
  .search-clear:hover { color: var(--tk-text); }

  .filter-select {
    height: 32px; padding: 0 10px; background: var(--tk-bg); border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-md); color: var(--tk-muted); font-size: 12px; font-family: inherit;
    cursor: pointer; outline: none; flex-shrink: 0;
  }
  .filter-select:focus { border-color: var(--tk-border-hi); }

  .layout-switch { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md); flex-shrink: 0; margin-left: auto; }
  .layout-switch button {
    width: 30px; height: 26px; border: none; background: none; color: var(--tk-muted);
    border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, color 0.15s;
  }
  .layout-switch button:hover { color: var(--tk-text); }
  .layout-switch button.active { background: var(--tk-surface-2); color: var(--tk-text); }

  /* ─── ERROR / LOADING / EMPTY ─── */
  .error-banner {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin: 10px 16px 0; padding: 9px 14px;
    background: rgba(244, 63, 94, 0.08); border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: var(--tk-radius-md); color: #f43f5e; font-size: 12.5px; flex-shrink: 0;
  }
  .error-banner button { background: none; border: none; color: inherit; cursor: pointer; display: flex; }

  .loading-state, .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    padding: 80px 20px; color: var(--tk-muted-2); font-size: 13px; flex: 1;
  }
  .spinner {
    width: 20px; height: 20px; border: 2px solid var(--tk-border); border-top-color: var(--tk-text);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ─── BOARD LAYOUT ─── */
  .board-scroll { flex: 1; overflow-x: auto; overflow-y: hidden; padding: 14px 16px; scroll-snap-type: x proximity; }
  .board-scroll::-webkit-scrollbar { height: 6px; }
  .board-scroll::-webkit-scrollbar-thumb { background: var(--tk-border); border-radius: 3px; }
  .board-row { display: flex; gap: 10px; align-items: flex-start; min-width: max-content; height: calc(100dvh - 128px); min-height: 360px; }
  .board-row :global(.col) { scroll-snap-align: start; }

  .add-column-btn {
    width: 220px; flex-shrink: 0; height: 42px; margin-top: 2px;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px dashed var(--tk-border); border-radius: var(--tk-radius-lg);
    background: none; color: var(--tk-muted); font-size: 12.5px; font-family: inherit; cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .add-column-btn:hover { border-color: var(--tk-border-hi); color: var(--tk-text); background: var(--tk-surface); }
  .add-column-btn-block { width: 100%; }

  .add-column-input {
    width: 220px; flex-shrink: 0; height: 42px; margin-top: 2px; padding: 0 14px;
    border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-lg);
    background: var(--tk-surface); color: var(--tk-text);
    font-size: 12.5px; font-family: inherit; outline: none;
  }
  .add-column-input-block { width: 100%; }

  /* ─── CONFIRM DIALOG ─── */
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 320;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center; padding: 16px;
    animation: fadeIn 0.12s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .confirm-dialog {
    background: var(--tk-surface); border: 1px solid var(--tk-border-hi);
    border-radius: var(--tk-radius-lg); box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    width: 100%; max-width: 360px; padding: 18px;
  }
  .confirm-title { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--tk-text); }
  .confirm-sub { margin: 0 0 16px; font-size: 12.5px; color: var(--tk-muted); line-height: 1.45; }
  .confirm-buttons { display: flex; gap: 8px; justify-content: flex-end; }
  .confirm-buttons button {
    height: 34px; padding: 0 16px; border-radius: var(--tk-radius-md);
    font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer; border: 1px solid transparent;
  }
  .confirm-cancel { background: var(--tk-surface-2); border-color: var(--tk-border); color: var(--tk-text); }
  .confirm-danger { background: rgba(244,63,94,0.12); border-color: rgba(244,63,94,0.3); color: #f43f5e; }
  .confirm-danger:hover { background: rgba(244,63,94,0.2); }

  /* ─── LIST LAYOUT ─── */
  .board-list {
    flex: 1; overflow-y: auto; padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; gap: 12px;
  }

  /* ─── FOCUS LAYOUT ─── */
  .focus-nav {
    display: flex; align-items: center; gap: 6px; padding: 12px 16px 0; flex-shrink: 0; min-width: 0;
  }
  .focus-tabs {
    display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0;
  }
  .focus-tabs::-webkit-scrollbar { display: none; }

  /* Selector do mobile — some no desktop, onde as pills mandam. */
  .focus-select {
    display: none; flex: 1; min-width: 0; height: 36px; padding: 0 12px;
    background: var(--tk-surface-2); border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md);
    color: var(--tk-text); font-size: 13px; font-weight: 600; font-family: inherit; outline: none; cursor: pointer;
  }
  .focus-column-input {
    flex: 1; min-width: 0; height: 36px; padding: 0 12px;
    background: var(--tk-surface-2); border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-md);
    color: var(--tk-text); font-size: 13px; font-family: inherit; outline: none;
  }
  .focus-pill {
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
    height: 32px; padding: 0 12px; border-radius: 20px;
    background: var(--tk-surface); border: 1px solid var(--tk-border); color: var(--tk-muted);
    font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer;
    transition: all 0.15s;
  }
  .focus-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--c); opacity: 0.5; }
  .focus-pill.active { border-color: var(--c); color: var(--tk-text); background: var(--tk-surface-2); }
  .focus-pill.active::before { opacity: 1; }
  .focus-pill-count { font-size: 10px; color: var(--tk-muted-2); }
  .focus-pill-add { padding: 0 10px; }
  .focus-pill-add::before { content: none; }

  .focus-body {
    flex: 1; padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
    display: flex; min-height: 0;
  }
  .focus-body :global(.col) { height: 100%; }

  /* ─── CLOSED COLUMNS ─── */
  .closed-row { display: flex; gap: 6px; flex-wrap: wrap; padding-top: 4px; }
  .closed-row-focus { padding: 8px 16px 12px; }
  .closed-chip {
    display: flex; align-items: center; gap: 6px;
    height: 28px; padding: 0 12px; border-radius: 20px;
    background: var(--tk-surface); border: 1px solid var(--tk-border); color: var(--tk-muted);
    font-size: 11.5px; font-family: inherit; cursor: pointer; border-top: 2px solid var(--c);
    transition: color 0.15s, border-color 0.15s;
  }
  .closed-chip:hover { color: var(--tk-text); border-color: var(--tk-border-hi); }

  @media (max-width: 768px) {
    .focus-select { display: block; }
    .focus-tabs { display: none; }
  }

  @media (max-width: 640px) {
    .topbar { padding-left: 12px; padding-right: 12px; }
    .board-scroll, .board-list, .focus-nav, .focus-body { padding-left: 12px; padding-right: 12px; }
    .search-box { min-width: 120px; }
    .layout-switch { margin-left: 0; }
  }
</style>
