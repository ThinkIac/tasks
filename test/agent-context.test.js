import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildAgentContext } from '../lib/agent-context.js';
import { renderTemplate } from 'inflect';

const now = Date.parse('2026-08-01T12:00:00.000Z');
const boards = [{ id: 'board-1', name: 'Product' }];
const columns = [
  { id: 'open', name: 'To do', kind: 'open' },
  { id: 'done', name: 'Done', kind: 'done' },
  { id: 'cancelled', name: 'Cancelled', kind: 'cancelled' },
];

test('separa abertas, próximas 24h e fechadas usando o tipo da coluna', () => {
  const context = buildAgentContext({
    now, boards, columns,
    tasks: [
      { id: 'soon', title: 'Due soon', boardId: 'board-1', columnId: 'open', dueDate: '2026-08-02T11:59:00.000Z' },
      { id: 'later', title: 'Due later', boardId: 'board-1', columnId: 'open', dueDate: '2026-08-02T12:01:00.000Z' },
      { id: 'past', title: 'Overdue', boardId: 'board-1', columnId: 'open', dueDate: '2026-08-01T11:59:00.000Z' },
      { id: 'done', title: 'Finished', boardId: 'board-1', columnId: 'done', updatedAt: '2026-08-01T10:00:00.000Z' },
      { id: 'cancelled', title: 'Stopped', boardId: 'board-1', columnId: 'cancelled', updatedAt: '2026-08-01T11:00:00.000Z' },
    ],
  });

  assert.deepEqual(context.openTasks.map(task => task.id), ['past', 'soon', 'later']);
  assert.deepEqual(context.dueSoonTasks.map(task => task.id), ['soon']);
  assert.deepEqual(context.closedTasks.map(task => task.id), ['cancelled', 'done']);
  assert.equal(context.openTasks[0].board, 'Product');
  assert.equal(context.openTasks[0].column, 'To do');
});

test('limita listas sem perder as contagens totais', () => {
  const tasks = Array.from({ length: 3 }, (_, index) => ({
    id: `task-${index}`, title: `Task ${index}`, boardId: 'board-1', columnId: 'open',
  }));
  const context = buildAgentContext({ now, boards, columns, tasks, limit: 2 });
  assert.equal(context.openCount, 3);
  assert.equal(context.openTasks.length, 2);
  assert.deepEqual(context.dueSoonTasks, []);
  assert.deepEqual(context.closedTasks, []);
});

test('o AGENT.md renderiza o snapshot e o protocolo do widget', () => {
  const source = readFileSync(resolve('packages/tasks/AGENT.md'), 'utf8');
  const body = source.replace(/^---[\s\S]*?---\s*/, '');
  const rendered = renderTemplate(body, {
    openCount: 1,
    dueSoonCount: 1,
    closedCount: 0,
    openTasks: [{ id: 'open-1', title: 'Open task', board: 'Product', column: 'To do', priority: 'high', dueDate: null }],
    dueSoonTasks: [{ id: 'due-1', title: 'Due task', dueDate: '2026-08-02T11:00:00.000Z' }],
    closedTasks: [],
    relatedTasks: [{ id: 'related-1', title: 'Related task', score: 0.91 }],
  }, { baseDir: dirname(resolve('packages/tasks/AGENT.md')) });

  assert.match(rendered, /Open task/);
  assert.match(rendered, /Due task/);
  assert.match(rendered, /No closed tasks/);
  assert.match(rendered, /Related task/);
  assert.match(rendered, /\{"taskId":"<real-task-id>"\}/);
});
