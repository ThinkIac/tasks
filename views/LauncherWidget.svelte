<script>
  import { onMount } from 'svelte';
  import { listBoards, listColumns, listTasks } from './lib/api.js';

  let loading = true;
  let open = 0;
  let done = 0;
  let next = '';

  onMount(async () => {
    try {
      const boards = await listBoards();
      const board = boards[0];
      if (!board) return;
      const [columns, tasks] = await Promise.all([listColumns(board.id), listTasks(board.id)]);
      const complete = new Set(columns.filter(column => column.closed || column.kind === 'done').map(column => column.id));
      done = tasks.filter(task => complete.has(task.columnId)).length;
      open = tasks.length - done;
      next = tasks.find(task => !complete.has(task.columnId))?.title || '';
    } catch {
      // The launcher remains useful offline and simply shows its empty state.
    } finally {
      loading = false;
    }
  });
</script>

<main aria-label="Resumo das tarefas">
  <div class="heading"><span>Tasks</span><small>Hoje</small></div>
  {#if loading}
    <p class="muted">Atualizando tarefas…</p>
  {:else}
    <div class="counts"><strong>{open}</strong><span>abertas</span><i></i><strong>{done}</strong><span>concluídas</span></div>
    <p class:muted={!next} class="next">{next ? `Próxima: ${next}` : 'Nada pendente por enquanto.'}</p>
  {/if}
</main>

<style>
  :global(html), :global(body) { background: transparent; margin: 0; min-height: 100%; }
  main { box-sizing: border-box; color: white; font-family: system-ui, sans-serif; height: 150px; padding: 20px 22px; background: linear-gradient(130deg, rgba(45,212,191,.28), rgba(8,19,25,.20)); border: 1px solid rgba(255,255,255,.16); border-radius: 20px; }
  .heading { display: flex; align-items: center; justify-content: space-between; font-size: 17px; font-weight: 650; }
  small { color: rgba(255,255,255,.62); font-size: 12px; font-weight: 500; }
  .counts { display: flex; align-items: baseline; gap: 6px; margin-top: 20px; }
  strong { font-size: 28px; font-weight: 650; }
  .counts span { color: rgba(255,255,255,.72); font-size: 13px; }
  i { height: 16px; margin: 0 6px; width: 1px; background: rgba(255,255,255,.26); }
  .next, .muted { color: rgba(255,255,255,.72); font-size: 13px; margin: 13px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: rgba(255,255,255,.55); }
</style>
