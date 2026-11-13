import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskSource } from '../views/lib/message-widget.js';

test('aceita taskId único', () => {
  assert.deepEqual(parseTaskSource('{"taskId":"task-1"}'), ['task-1']);
});

test('aceita taskIds, remove duplicados e preserva a ordem', () => {
  assert.deepEqual(
    parseTaskSource('{"taskIds":["task-2","task-1","task-2"]}'),
    ['task-2', 'task-1'],
  );
});

test('aceita uma string de ID como forma compacta', () => {
  assert.deepEqual(parseTaskSource('task-1'), ['task-1']);
});

test('rejeita payload inválido ou sem IDs', () => {
  assert.throws(() => parseTaskSource('{'), /Invalid payload/);
  assert.throws(() => parseTaskSource('{}'), /taskId or taskIds/);
  assert.throws(() => parseTaskSource('{"taskIds":[]}'), /taskId or taskIds/);
});

test('limita o widget a 20 tasks', () => {
  const ids = Array.from({ length: 21 }, (_, index) => `task-${index}`);
  assert.throws(() => parseTaskSource(JSON.stringify({ taskIds: ids })), /at most 20/);
});
