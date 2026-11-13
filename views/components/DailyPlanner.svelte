<script>
  import TaskCard from './TaskCard.svelte';

  export let tasks = [];
  export let columns = [];
  export let boards = [];
  export let loadColumns = async () => [];
  export let onOpenTask = () => {};
  export let onDeleteTask = () => {};
  export let onMoveTask = () => {};
  export let onDragStartTask = () => {};
  export let onDragEndTask = () => {};
  export let onAddTask = async () => {};

  let title = '';
  let adding = false;

  const priorityWeight = { urgent: 0, high: 1, medium: 2, low: 3 };
  const sameDay = (value, day) => {
    if (!value) return false;
    const date = new Date(value);
    return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate();
  };
  const labelDate = date => date.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const compareTasks = (a, b) => {
    const timeA = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const timeB = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    return timeA - timeB || (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2) || a.order - b.order;
  };

  $: today = new Date();
  $: terminalIds = new Set(columns.filter(column => column.closed || ['done', 'cancelled'].includes(column.kind)).map(column => column.id));
  $: planned = tasks.filter(task => !terminalIds.has(task.columnId) && sameDay(task.dueDate, today)).sort(compareTasks);
  $: inbox = tasks.filter(task => !terminalIds.has(task.columnId) && !task.dueDate).sort(compareTasks);
  $: completed = tasks.filter(task => terminalIds.has(task.columnId) && sameDay(task.dueDate, today)).sort(compareTasks);
  $: openCount = planned.length + inbox.length;

  async function submit() {
    const value = title.trim();
    if (!value || adding) return;
    adding = true;
    title = '';
    try { await onAddTask(value); }
    finally { adding = false; }
  }
</script>

<section class="planner" aria-label="Planejador diário">
  <header class="planner-head">
    <div>
      <p>MEU DIA</p>
      <h1>{labelDate(today)}</h1>
    </div>
    <div class="progress" aria-label={`${completed.length} de ${completed.length + openCount} tarefas concluídas`}>
      <strong>{completed.length}/{completed.length + openCount}</strong>
      <span>concluídas</span>
    </div>
  </header>

  <form class="quick-add" on:submit|preventDefault={submit}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <input bind:value={title} placeholder="Adicionar tarefa para hoje" aria-label="Adicionar tarefa para hoje" maxlength="200" />
    <button type="submit" disabled={!title.trim() || adding}>{adding ? 'Adicionando…' : 'Adicionar'}</button>
  </form>

  <div class="planner-grid">
    <div class="planner-section">
      <div class="section-title"><h2>Programadas</h2><span>{planned.length}</span></div>
      <div class="task-list">
        {#each planned as task (task.id)}
          <TaskCard {task} {boards} {loadColumns} onOpen={onOpenTask} onDelete={onDeleteTask} onMove={onMoveTask} onDragStart={onDragStartTask} onDragEnd={onDragEndTask} />
        {:else}
          <p class="empty">Defina um horário ao editar uma tarefa para organizar sua sequência.</p>
        {/each}
      </div>
    </div>
    <div class="planner-section">
      <div class="section-title"><h2>Lista do dia</h2><span>{inbox.length}</span></div>
      <div class="task-list">
        {#each inbox as task (task.id)}
          <TaskCard {task} {boards} {loadColumns} onOpen={onOpenTask} onDelete={onDeleteTask} onMove={onMoveTask} onDragStart={onDragStartTask} onDragEnd={onDragEndTask} />
        {:else}
          <p class="empty">Sua lista está livre. Adicione o que deseja realizar hoje.</p>
        {/each}
      </div>
    </div>
  </div>

  {#if completed.length}
    <div class="planner-section completed">
      <div class="section-title"><h2>Concluídas hoje</h2><span>{completed.length}</span></div>
      <div class="task-list compact">
        {#each completed as task (task.id)}
          <TaskCard {task} {boards} {loadColumns} onOpen={onOpenTask} onDelete={onDeleteTask} onMove={onMoveTask} onDragStart={onDragStartTask} onDragEnd={onDragEndTask} />
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .planner { max-width: 1060px; margin: 0 auto; padding: 26px; }
  .planner-head { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
  .planner-head p { margin: 0 0 6px; color: var(--tk-muted); font-size: 10px; font-weight: 700; letter-spacing: .14em; }
  h1 { margin: 0; font-size: 25px; font-weight: 500; text-transform: capitalize; }
  .progress { display: grid; grid-template-columns: auto auto; column-gap: 6px; align-items: baseline; color: var(--tk-muted); }
  .progress strong { color: var(--tk-text); font-size: 18px; font-weight: 500; }
  .progress span { font-size: 12px; }
  .quick-add { display: flex; align-items: center; gap: 10px; padding: 8px 9px 8px 13px; background: var(--tk-surface); border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-md); }
  .quick-add svg { color: var(--tk-muted); flex: 0 0 auto; }
  .quick-add input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--tk-text); font: inherit; }
  .quick-add input::placeholder { color: var(--tk-muted); }
  .quick-add button { border: 0; border-radius: 6px; padding: 8px 11px; background: var(--tk-accent); color: var(--tk-on-accent); font: 500 12px var(--tk-font); cursor: pointer; }
  .quick-add button:disabled { opacity: .45; cursor: default; }
  .planner-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px; }
  .planner-section { min-width: 0; padding: 15px; background: var(--tk-surface); border: 1px solid var(--tk-border); border-radius: var(--tk-radius-lg); }
  .section-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  h2 { margin: 0; font-size: 13px; font-weight: 500; }
  .section-title span { min-width: 20px; padding: 2px 6px; border-radius: 99px; background: var(--tk-surface-2); color: var(--tk-muted); font-size: 11px; text-align: center; }
  .empty { margin: 0; color: var(--tk-muted); font-size: 12px; line-height: 1.55; }
  .completed { margin-top: 14px; opacity: .72; }
  .compact { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
  @media (max-width: 700px) { .planner { padding: 18px; } .planner-grid { grid-template-columns: 1fr; } .compact { grid-template-columns: 1fr; } .planner-head { align-items: start; } }
</style>
