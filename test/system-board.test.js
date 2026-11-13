import test from 'node:test';
import assert from 'node:assert/strict';

import { SYSTEM_BOARD_NAME, SYSTEM_COLUMNS, belongsToSystemBoard } from '../lib/system-board.js';

test('define o board Sistema com o fluxo operacional acordado', () => {
  assert.equal(SYSTEM_BOARD_NAME, 'Sistema');
  assert.deepEqual(SYSTEM_COLUMNS.map(column => column.name), ['Backlog', 'Pendente', 'Fazendo', 'Feito']);
  assert.equal(SYSTEM_COLUMNS.at(-1).kind, 'done');
});

test('seleciona somente tags operacionais e os cards explícitos de Fleet/Dashboard Fase 5', () => {
  assert.equal(belongsToSystemBoard({ title: 'Mover imagem entre hosts', tags: ['deploy'] }), true);
  assert.equal(belongsToSystemBoard({ title: 'Dashboard Fase 5', tags: [] }), true);
  assert.equal(belongsToSystemBoard({ title: 'Ajustar Fleet', tags: [] }), true);
  assert.equal(belongsToSystemBoard({ title: 'Melhorar copy do runtime', tags: [] }), false);
  assert.equal(belongsToSystemBoard({ title: 'Pesquisa de infra', tags: ['produto'] }), false);
});
