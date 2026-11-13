// Shared fetch helpers for the tasks Kanban view.

const BASE = '/tasks';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Erro ${res.status}`);
  }
  return res.json();
}

// Boards
export const listBoards = () => req('GET', '/boards');
export const createBoard = data => req('POST', '/boards', data);
export const updateBoard = (id, changes) => req('PATCH', `/boards/${id}`, changes);
export const deleteBoard = id => req('DELETE', `/boards/${id}`);
export const reorderBoards = ids => req('POST', '/boards/reorder', { ids });

// Columns
export const listColumns = boardId => req('GET', `/columns?boardId=${encodeURIComponent(boardId)}`);
export const createColumn = data => req('POST', '/columns', data);
export const updateColumn = (id, changes) => req('PATCH', `/columns/${id}`, changes);
export const deleteColumn = (id, moveTo) => req('DELETE', `/columns/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`);
export const reorderColumns = ids => req('POST', '/columns/reorder', { ids });

// Tasks
export const listTasks = boardId => req('GET', `/tasks?boardId=${encodeURIComponent(boardId)}`);
export const getTask = id => req('GET', `/tasks/${encodeURIComponent(id)}`);
export const createTask = data => req('POST', '/tasks', data);
export const createTaskFromText = text => req('POST', '/create-from-text', { text });
export const updateTask = (id, changes) => req('PATCH', `/tasks/${id}`, changes);
export const deleteTask = id => req('DELETE', `/tasks/${id}`);
// Move entre colunas de qualquer board (o backend valida coluna↔board e reordena).
export const moveTask = (id, target) => req('POST', `/tasks/${id}/move`, target);
export const reorderTasks = (columnId, ids) => req('POST', '/tasks/reorder', { columnId, ids });

// Comentários
export const listComments = taskId => req('GET', `/tasks/${taskId}/comments`);
export const addComment = (taskId, content, author) => req('POST', `/tasks/${taskId}/comments`, { content, author });
export const deleteComment = id => req('DELETE', `/comments/${id}`);

// Contexto: comentários da tarefa.
export const getTaskContext = taskId => req('GET', `/tasks/${taskId}/context`);

// Stream ao vivo: mexeu o board (aqui, em outra aba ou por uma tool), todo
// mundo que estiver olhando recebe o evento.
export const eventsUrl = () => `${BASE}/events`;
