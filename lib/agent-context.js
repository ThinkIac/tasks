const MAX_CONTEXT_TASKS = 12;

function timeOf(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function compactTask(task, boardById, columnById) {
  const column = columnById.get(task.columnId);
  return {
    id: task.id,
    title: task.title,
    board: boardById.get(task.boardId)?.name ?? 'Unknown board',
    column: column?.name ?? 'Unknown column',
    priority: task.priority || 'medium',
    dueDate: task.dueDate || null,
    kind: column?.kind || 'open',
    updatedAt: task.updatedAt || null,
  };
}

/**
 * Builds the small, current snapshot used by the Tasks AGENT.md. Kept free of
 * runtime dependencies so the date boundaries and classifications are testable.
 */
export function buildAgentContext({ tasks = [], boards = [], columns = [], now = Date.now(), limit = MAX_CONTEXT_TASKS } = {}) {
  const boardById = new Map(boards.map(board => [board.id, board]));
  const columnById = new Map(columns.map(column => [column.id, column]));
  const rows = tasks.map(task => compactTask(task, boardById, columnById));
  const end = now + (24 * 60 * 60 * 1000);
  const byDueDate = (a, b) => (timeOf(a.dueDate) ?? Infinity) - (timeOf(b.dueDate) ?? Infinity);
  const byNewest = (a, b) => (timeOf(b.updatedAt) ?? 0) - (timeOf(a.updatedAt) ?? 0);

  const open = rows.filter(task => task.kind === 'open').sort(byDueDate);
  const dueSoon = open.filter(task => {
    const due = timeOf(task.dueDate);
    return due !== null && due >= now && due <= end;
  }).sort(byDueDate);
  const closed = rows.filter(task => task.kind !== 'open').sort(byNewest);

  return {
    openTasks: open.slice(0, limit),
    dueSoonTasks: dueSoon.slice(0, limit),
    closedTasks: closed.slice(0, limit),
    openCount: open.length,
    dueSoonCount: dueSoon.length,
    closedCount: closed.length,
  };
}
