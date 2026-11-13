<script>
  import { onMount } from 'svelte';
  import * as api from '../lib/api.js';
  import { renderMarkdown } from '../lib/markdown.js';
  import { parseTags } from '../lib/tags.js';

  export let task;
  export let columns = [];
  export let boardId = '';
  export let onSave = () => {};
  export let onDelete = () => {};
  export let onClose = () => {};

  let form = {
    title: task.title || '',
    description: task.description || '',
    priority: task.priority || 'medium',
    boardId: task.boardId || boardId,
    columnId: task.columnId,
    dueDate: task.dueDate ? task.dueDate.slice(0, 16) : '',
    tags: parseTags(task.tags).join(', '),
    resolution: task.resolution || '',
  };

  /* Descrição: escrever em Markdown, ler renderizado. Abre em leitura quando já
   * existe texto (o caso comum é consultar, não editar) e em edição quando está
   * vazia. */
  let editingDescription = !task.description;

  // Comentários são carregados em uma chamada e recarregados a cada alteração.
  let context = null;
  let contextError = '';
  let newComment = '';
  let sendingComment = false;

  async function loadContext() {
    contextError = '';
    try { context = await api.getTaskContext(task.id); }
    catch (e) { contextError = e.message; }
  }

  async function submitComment() {
    const content = newComment.trim();
    if (!content || sendingComment) return;
    sendingComment = true;
    newComment = '';
    try {
      const comment = await api.addComment(task.id, content, 'user');
      context = { ...context, comments: [...(context?.comments ?? []), comment] };
    } catch (e) { contextError = e.message; newComment = content; }
    finally { sendingComment = false; }
  }

  async function removeComment(id) {
    const previous = context?.comments ?? [];
    context = { ...context, comments: previous.filter(c => c.id !== id) };
    try { await api.deleteComment(id); }
    catch (e) { contextError = e.message; context = { ...context, comments: previous }; }
  }

  function formatWhen(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // Board de origem: enquanto o usuário não trocar de board, as colunas são as
  // que já vieram do pai (sem round-trip). Ao trocar, buscamos as do destino.
  let boards = [];
  let targetColumns = columns;
  let loadingColumns = false;

  onMount(async () => {
    try { boards = await api.listBoards(); } catch { boards = []; }
    loadContext();
  });

  async function onBoardChange() {
    loadingColumns = true;
    try {
      targetColumns = await api.listColumns(form.boardId);
      // Ao mudar de board a coluna antiga não existe mais lá — cai na primeira.
      if (!targetColumns.some(c => c.id === form.columnId)) {
        form.columnId = targetColumns[0]?.id ?? '';
      }
    } catch { targetColumns = []; }
    finally { loadingColumns = false; }
  }

  function save() {
    const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean);
    onSave({
      title: form.title,
      description: form.description,
      priority: form.priority,
      boardId: form.boardId,
      columnId: form.columnId,
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      tags,
      resolution: form.resolution || null,
    });
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
    // Ctrl/Cmd+Enter no campo de comentário envia o comentário, não a task.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      if (event.target?.dataset?.role === 'comment') submitComment();
      else save();
    }
  }
</script>

<div class="modal-overlay" role="presentation" on:click={onClose} on:keydown={handleKeydown}>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown={handleKeydown}>
    <div class="modal-header">
      <input class="modal-title-input" bind:value={form.title} placeholder="Título da tarefa" autofocus />
      <button class="modal-close-btn" on:click={onClose} aria-label="Fechar">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>

    <div class="modal-body">
      <div class="modal-section">
        <div class="modal-section-head">
          <span class="modal-label">Descrição</span>
          <button
            class="modal-mini-btn"
            on:click={() => (editingDescription = !editingDescription)}
          >{editingDescription ? 'Visualizar' : 'Editar'}</button>
        </div>
        {#if editingDescription}
          <textarea id="task-desc" bind:value={form.description} placeholder="Adicionar descrição… (Markdown)" rows="6" class="modal-textarea"></textarea>
        {:else if form.description.trim()}
          <div class="md">{@html renderMarkdown(form.description)}</div>
        {:else}
          <button class="modal-empty-btn" on:click={() => (editingDescription = true)}>Adicionar descrição…</button>
        {/if}
      </div>

      <div class="modal-props-grid">
        <div class="modal-prop">
          <span class="modal-prop-label">Board</span>
          <select bind:value={form.boardId} on:change={onBoardChange} class="modal-prop-select">
            {#each boards as b}<option value={b.id}>{b.name}</option>{/each}
          </select>
        </div>
        <div class="modal-prop">
          <span class="modal-prop-label">Coluna</span>
          <select bind:value={form.columnId} class="modal-prop-select" disabled={loadingColumns}>
            {#each targetColumns as c}<option value={c.id}>{c.name}</option>{/each}
          </select>
        </div>
        <div class="modal-prop">
          <span class="modal-prop-label">Prioridade</span>
          <select bind:value={form.priority} class="modal-prop-select">
            <option value="low">Baixa</option>
            <option value="medium">Média</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
        </div>
        <div class="modal-prop">
          <span class="modal-prop-label">Vencimento</span>
          <input type="datetime-local" bind:value={form.dueDate} class="modal-prop-input" />
        </div>
        <div class="modal-prop">
          <span class="modal-prop-label">Tags</span>
          <input type="text" bind:value={form.tags} placeholder="frontend, bug" class="modal-prop-input" />
        </div>
      </div>

      <div class="modal-section">
        <label class="modal-label" for="task-res">Resolução</label>
        <textarea id="task-res" bind:value={form.resolution} placeholder="Como foi resolvido, decisões, links…" rows="3" class="modal-textarea modal-textarea-mono"></textarea>
      </div>

      <div class="modal-section">
        <div class="modal-section-head">
          <span class="modal-label">Comentários</span>
          {#if context?.comments?.length}<span class="modal-badge">{context.comments.length}</span>{/if}
        </div>

        {#if contextError}
          <div class="ctx-error">{contextError}</div>
        {/if}

        <div class="comments">
          {#each context?.comments ?? [] as comment (comment.id)}
            <div class="comment" class:agent={comment.author !== 'user'}>
              <div class="comment-head">
                <span class="comment-author">{comment.author === 'user' ? 'Você' : comment.author}</span>
                <span class="comment-when">{formatWhen(comment.createdAt)}</span>
                <button class="comment-del" title="Excluir comentário" aria-label="Excluir comentário" on:click={() => removeComment(comment.id)}>
                  <svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
              </div>
              <div class="md md-comment">{@html renderMarkdown(comment.content)}</div>
            </div>
          {/each}
          {#if context && !context.comments.length}
            <p class="ctx-empty">Nenhum comentário ainda.</p>
          {/if}
        </div>

        <div class="comment-new">
          <textarea
            data-role="comment"
            bind:value={newComment}
            placeholder="Escrever um comentário… (Markdown, Ctrl+Enter envia)"
            rows="2"
            class="modal-textarea"
          ></textarea>
          <button class="modal-btn modal-btn-save comment-send" disabled={!newComment.trim() || sendingComment} on:click={submitComment}>
            {sendingComment ? 'Enviando…' : 'Comentar'}
          </button>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <button class="modal-btn modal-btn-danger" on:click={() => onDelete(task.id)}>Excluir</button>
      <div class="modal-footer-right">
        <button class="modal-btn modal-btn-cancel" on:click={onClose}>Cancelar</button>
        <button class="modal-btn modal-btn-save" on:click={save}>Salvar</button>
      </div>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    z-index: 300; padding: 16px;
    animation: fadeIn 0.12s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .modal {
    background: var(--tk-surface);
    border: 1px solid var(--tk-border-hi);
    border-radius: var(--tk-radius-lg);
    width: 100%; max-width: 560px;
    max-height: 92dvh; overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    animation: slideUp 0.15s cubic-bezier(0.34, 1.2, 0.64, 1);
  }
  @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .modal-header {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--tk-border);
    position: sticky; top: 0; background: var(--tk-surface); z-index: 1;
  }
  .modal-title-input {
    flex: 1; background: none; border: none; outline: none;
    color: var(--tk-text); font-size: 16px; font-weight: 600; font-family: inherit;
  }
  .modal-title-input::placeholder { color: var(--tk-muted-2); font-weight: 400; }
  .modal-close-btn {
    width: 26px; height: 26px; border: 1px solid var(--tk-border);
    background: none; color: var(--tk-muted); border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; flex-shrink: 0; transition: all 0.12s;
  }
  .modal-close-btn:hover { background: rgba(244,63,94,0.08); border-color: rgba(244,63,94,0.25); color: #f43f5e; }

  .modal-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

  .modal-section { display: flex; flex-direction: column; gap: 6px; }
  .modal-label { font-size: 10.5px; font-weight: 600; color: var(--tk-muted-2); text-transform: uppercase; letter-spacing: 0.06em; }

  .modal-textarea {
    width: 100%; background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-md); padding: 9px 11px; color: var(--tk-text);
    font-size: 13px; font-family: inherit; outline: none; resize: vertical; min-height: 68px; line-height: 1.5;
  }
  .modal-textarea:focus { border-color: var(--tk-border-hi); }
  .modal-textarea::placeholder { color: var(--tk-muted-2); }
  .modal-textarea-mono { font-family: var(--tk-mono); font-size: 12px; }

  .modal-section-head { display: flex; align-items: center; gap: 8px; }
  .modal-mini-btn {
    margin-left: auto; border: 1px solid var(--tk-border); background: none;
    color: var(--tk-muted); border-radius: 5px; padding: 2px 8px;
    font: 500 10.5px inherit; font-family: inherit; cursor: pointer;
  }
  .modal-mini-btn:hover { border-color: var(--tk-border-hi); color: var(--tk-text); }
  .modal-badge {
    margin-left: auto; font-size: 10px; color: var(--tk-muted);
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    border-radius: 10px; padding: 1px 7px; font-variant-numeric: tabular-nums;
  }
  .modal-empty-btn {
    text-align: left; border: 1px dashed var(--tk-border); background: none;
    color: var(--tk-muted-2); border-radius: var(--tk-radius-md);
    padding: 10px 11px; font: 13px inherit; font-family: inherit; cursor: pointer;
  }
  .modal-empty-btn:hover { border-color: var(--tk-border-hi); color: var(--tk-muted); }

  /* Markdown renderizado (descrição e comentários) */
  .md { font-size: 13px; line-height: 1.65; color: var(--tk-text); word-wrap: break-word; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) {
    font-size: 14.5px; font-weight: 600; line-height: 1.3; margin: 14px 0 6px;
  }
  .md :global(h1) { font-size: 17px; }
  .md :global(h2) { font-size: 15.5px; }
  .md :global(p) { margin: 0 0 8px; }
  .md :global(ul), .md :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(li.md-check) { list-style: none; margin-left: -18px; display: flex; gap: 7px; align-items: flex-start; }
  .md :global(li.md-check .md-box) {
    width: 13px; height: 13px; flex-shrink: 0; margin-top: 3px;
    border: 1px solid var(--tk-border-hi); border-radius: 3px;
    font-size: 9px; line-height: 12px; text-align: center; color: var(--tk-accent);
  }
  .md :global(li.md-check.done) { color: var(--tk-muted); text-decoration: line-through; }
  .md :global(code) {
    font-family: var(--tk-mono); font-size: 11.5px;
    background: var(--tk-surface-2); border-radius: 4px; padding: 1px 5px;
  }
  .md :global(pre.md-pre) {
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-md); padding: 10px; overflow-x: auto; margin: 0 0 8px;
  }
  .md :global(pre.md-pre code) { background: none; padding: 0; font-size: 11.5px; line-height: 1.5; }
  .md :global(blockquote) {
    border-left: 3px solid var(--tk-border-hi); padding-left: 10px;
    margin: 0 0 8px; color: var(--tk-muted);
  }
  .md :global(hr) { border: 0; border-top: 1px solid var(--tk-border); margin: 12px 0; }
  .md :global(a) { color: var(--tk-accent); }
  .md :global(*:last-child) { margin-bottom: 0; }

  /* Comentários */
  .comments { display: flex; flex-direction: column; gap: 8px; }
  .comment {
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    border-left: 2px solid var(--tk-border-hi);
    border-radius: var(--tk-radius-md); padding: 8px 10px;
  }
  .comment.agent { border-left-color: var(--tk-accent); }
  .comment-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .comment-author { font-size: 11px; font-weight: 600; color: var(--tk-text); }
  .comment-when { font-size: 10px; color: var(--tk-muted-2); }
  .comment-del {
    margin-left: auto; border: none; background: none; color: var(--tk-muted-2);
    cursor: pointer; padding: 2px; border-radius: 4px; display: flex;
  }
  .comment-del:hover { color: #f43f5e; background: rgba(244,63,94,0.1); }
  .md-comment { font-size: 12.5px; }
  .comment-new { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
  .comment-new .modal-textarea { min-height: 48px; }
  .comment-send { height: 30px; padding: 0 14px; font-size: 12px; }
  .comment-send:disabled { opacity: 0.5; cursor: default; }
  .ctx-error { font-size: 11.5px; color: #f43f5e; }
  .ctx-empty { font-size: 12px; color: var(--tk-muted-2); margin: 0; }

  .modal-props-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .modal-prop-wide { grid-column: 1 / -1; }
  .modal-prop { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .modal-prop-label { font-size: 10.5px; font-weight: 600; color: var(--tk-muted-2); text-transform: uppercase; letter-spacing: 0.06em; }

  .modal-prop-select, .modal-prop-input {
    height: 34px; padding: 0 10px;
    background: var(--tk-surface-2); border: 1px solid var(--tk-border);
    border-radius: var(--tk-radius-md); color: var(--tk-text);
    font-size: 12.5px; font-family: inherit; outline: none; width: 100%;
  }
  .modal-prop-select:focus, .modal-prop-input:focus { border-color: var(--tk-border-hi); }

  .modal-footer {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 12px 16px 16px;
    border-top: 1px solid var(--tk-border);
  }
  .modal-footer-right { display: flex; gap: 8px; }
  .modal-btn {
    height: 34px; padding: 0 16px;
    border-radius: var(--tk-radius-md); font-size: 13px; font-weight: 500;
    font-family: inherit; cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
  }
  .modal-btn-danger { background: none; border-color: transparent; color: #f43f5e; }
  .modal-btn-danger:hover { background: rgba(244,63,94,0.08); }
  .modal-btn-cancel { background: var(--tk-surface-2); border-color: var(--tk-border); color: var(--tk-muted); }
  .modal-btn-cancel:hover { border-color: var(--tk-border-hi); color: var(--tk-text); }
  .modal-btn-save { background: var(--tk-accent); border-color: var(--tk-accent); color: var(--tk-on-accent); }
  .modal-btn-save:hover { opacity: 0.88; }

  @media (max-width: 560px) {
    .modal-props-grid { grid-template-columns: 1fr; }
  }
</style>
