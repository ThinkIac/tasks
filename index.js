// packages/tasks/index.js
// Board Kanban — múltiplos boards, colunas personalizadas por board.
// Sem agente/auto-agente, sem auto-cycle, sem schedule (nada disso existe aqui).
import { getProxy, dispatchEvent, on } from 'logos';
import { runAgentTask } from '../agent/host/logos/index.js';
import { buildAgentContext } from './lib/agent-context.js';
import { SYSTEM_BOARD_NAME, SYSTEM_COLUMNS, belongsToSystemBoard } from './lib/system-board.js';

const LEGACY_STATUS = 'kanban';
const TASK_EMBEDDINGS_COLLECTION = 'tasks:descriptions';

/* Embeddings é uma capacidade opcional. A comunicação pelo bus evita importar
 * o pacote diretamente: sem listener instalado o payload volta intacto e a
 * tarefa continua com a busca/gravação normal. */
function taskEmbeddingDocument(task) {
  const db = getProxy('tasks');
  const board = db.board[task.boardId];
  const column = db.column[task.columnId];
  const tags = parseTags(task.tags);
  return {
    id: task.id,
    content: [
      task.title,
      task.description,
      task.resolution,
      tags.length ? `Tags: ${tags.join(', ')}` : null,
      board?.name ? `Board: ${board.name}` : null,
      column?.name ? `Coluna: ${column.name}` : null,
      task.priority ? `Prioridade: ${task.priority}` : null,
    ].filter(Boolean).join('\n'),
    metadata: {
      boardId: task.boardId,
      columnId: task.columnId,
      priority: task.priority,
      tags,
    },
  };
}

function scheduleTaskIndex(task) {
  if (!task?.id) return;
  void dispatchEvent('embeddings:upsert', {
    collection: TASK_EMBEDDINGS_COLLECTION,
    documents: [taskEmbeddingDocument(task)],
  }).catch(error => console.warn('[tasks] indexação opcional falhou:', error.message));
}

function scheduleTaskDelete(ids) {
  const validIds = ids.filter(Boolean);
  if (!validIds.length) return;
  void dispatchEvent('embeddings:delete', {
    collection: TASK_EMBEDDINGS_COLLECTION,
    ids: validIds,
  }).catch(error => console.warn('[tasks] remoção do índice opcional falhou:', error.message));
}

async function searchTaskMatches(query, limit = 200) {
  const text = String(query ?? '').trim();
  if (!text) return null;
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 800));
  try {
    const response = await Promise.race([
      dispatchEvent('embeddings:search', {
        collection: TASK_EMBEDDINGS_COLLECTION,
        query: text,
        limit,
      }),
      timeout,
    ]);
    const results = response?.result?.success ? response.result.results : null;
    if (!Array.isArray(results)) return null;
    const seen = new Set();
    return results
      .filter(result => result?.sourceId && !seen.has(result.sourceId) && seen.add(result.sourceId))
      .map(result => ({ id: result.sourceId, score: Number(result.score) || 0 }));
  } catch (error) {
    console.warn('[tasks] busca semântica opcional falhou:', error.message);
    return null;
  }
}

async function searchTaskIds(query) {
  const matches = await searchTaskMatches(query);
  return matches?.map(match => match.id) ?? null;
}

async function findDialogueCandidates(query, tasks) {
  const matches = await searchTaskMatches(query, 3);
  if (!matches?.length) return [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  return matches
    .map(match => ({ ...match, task: byId.get(match.id) }))
    .filter(match => match.task)
    .map(({ task, score }) => ({ id: task.id, title: task.title, score }));
}

/* ───────── Migração / seed (idempotente) ─────────
 * A tabela Task original tinha "status" TEXT NOT NULL sem DEFAULT físico no
 * SQLite (o runtime só injeta DEFAULT em colunas adicionadas via ALTER TABLE,
 * não na criação original). Por isso "status" continua no schema (ver
 * schema.prisma) — mas só é preenchido com um valor fixo (LEGACY_STATUS),
 * nunca lido. A migração real acontece aqui: tasks antigas que ainda não têm
 * boardId/columnId (preenchido com '' pelo runtime ao adicionar as colunas
 * novas via ALTER TABLE) são movidas para um board padrão, usando o valor
 * antigo de `status` (que continua fisicamente na linha, mesmo fora do
 * schema atual — RecordProxy expõe colunas cruas não declaradas) para
 * escolher a coluna correspondente. Nenhuma task é apagada.
 */
let _seeded = false;

async function ensureSeeded() {
  if (_seeded) return;
  const db = getProxy('tasks');

  let boards = db.board.query({}, { sort: 'order ASC' });
  if (boards.length === 0) {
    const board = await db.board.push({ name: 'Meu Board', color: '#2dd4bf', order: 0 });
    boards = [board];
  }

  for (const board of boards) {
    const columns = db.column.query({ boardId: board.id }, { sort: 'order ASC' });
    if (columns.length === 0) {
      const defaults = [
        { name: 'Backlog', color: '#94a3b8' },
        { name: 'Pendente', color: '#f472b6' },
        { name: 'Fazendo', color: '#a78bfa' },
        { name: 'Feito', color: '#2dd4bf', kind: 'done' },
        { name: 'Cancelado', color: '#64748b', kind: 'cancelled' },
      ];
      let order = 0;
      for (const d of defaults) {
        const kind = d.kind ?? 'open';
        await db.column.push({
          boardId: board.id, name: d.name, color: d.color, order: order++,
          kind, closed: kind !== 'open',
        });
      }
    }
  }

  // Colunas criadas antes do campo `kind` vêm com '' (ALTER TABLE) — classifica
  // as terminais pelo nome uma única vez; depois disso o usuário manda no kind.
  for (const col of db.column.query({ kind: '' })) {
    const name = (col.name ?? '').trim().toLowerCase();
    if (['feito', 'done', 'concluído', 'concluido'].includes(name)) col.kind = 'done';
    else if (['cancelado', 'cancelled', 'canceled'].includes(name)) col.kind = 'cancelled';
    else col.kind = 'open';
  }

  const orphanTasks = db.task.query({ boardId: '' });
  if (orphanTasks.length > 0) {
    const defaultBoard = boards[0];
    const columns = db.column.query({ boardId: defaultBoard.id }, { sort: 'order ASC' });
    const byName = Object.fromEntries(columns.map(c => [c.name, c]));
    const legacyMap = {
      backlog: byName['Backlog'],
      pending: byName['Pendente'],
      doing: byName['Fazendo'],
      awaiting_approval: byName['Fazendo'],
      done: byName['Feito'],
      cancelled: byName['Cancelado'],
    };
    for (const t of orphanTasks) {
      const legacyStatus = t.status || 'backlog';
      const col = legacyMap[legacyStatus] || columns[0];
      t.boardId = defaultBoard.id;
      t.columnId = col.id;
    }
  }

  // tags legadas gravadas torto (double-encoded ou lista separada por vírgula):
  // reescreve na forma canônica uma única vez. parseTags já sabe ler as duas.
  for (const t of db.task.query({})) {
    if (t.tags == null || t.tags === '') continue;
    const canonical = serializeTags(parseTags(t.tags));
    if (canonical !== t.tags) t.tags = canonical;
  }

  // Board operacional único. A criação e a migração são idempotentes, para
  // sobreviver a hot reloads sem duplicar board/colunas nem reordenar cards.
  let systemBoard = boards.find(board => board.name === SYSTEM_BOARD_NAME);
  if (!systemBoard) {
    systemBoard = await db.board.push({
      name: SYSTEM_BOARD_NAME,
      color: '#94a3b8',
      order: boards.length,
    });
    boards = [...boards, systemBoard];
  }
  let systemColumns = db.column.query({ boardId: systemBoard.id }, { sort: 'order ASC' });
  for (const [order, definition] of SYSTEM_COLUMNS.entries()) {
    if (systemColumns.some(column => column.name === definition.name)) continue;
    const column = await db.column.push({
      boardId: systemBoard.id,
      name: definition.name,
      color: definition.color,
      order,
      kind: definition.kind,
      closed: definition.kind !== 'open',
    });
    systemColumns = [...systemColumns, column];
  }

  const systemBacklog = systemColumns.find(column => column.name === 'Backlog');
  for (const task of db.task.query({})) {
    // Só cards ainda abertos entram no board operacional. Não se reabre nem
    // desloca histórico concluído/cancelado.
    const sourceColumn = db.column[task.columnId];
    if (sourceColumn?.kind !== 'open' || task.boardId === systemBoard.id) continue;
    if (belongsToSystemBoard({ title: task.title, tags: parseTags(task.tags) })) {
      task.boardId = systemBoard.id;
      task.columnId = systemBacklog.id;
    }
  }

  _seeded = true;
}

function stripLegacy(rec) {
  if (!rec) return rec;
  const obj = typeof rec.toJSON === 'function' ? rec.toJSON() : { ...rec };
  delete obj.status;
  // tags é TEXT com JSON no banco; para fora do package sempre sai array — se
  // vazasse a string crua, quem consome iteraria caractere a caractere.
  if ('tags' in obj) obj.tags = parseTags(obj.tags);
  return obj;
}

/* ───────── Boards ───────── */

async function handleListBoards() {
  await ensureSeeded();
  const db = getProxy('tasks');
  return db.board.query({}, { sort: 'order ASC' });
}

async function handleCreateBoard(data = {}) {
  await ensureSeeded();
  if (!data.title && !data.name) throw new Error('name é obrigatório');
  const db = getProxy('tasks');
  const boards = db.board.query({});
  const board = await db.board.push({
    name: data.name ?? data.title,
    color: data.color ?? '#2dd4bf',
    order: boards.length,
  });
  const defaults = [
    { name: 'Backlog', color: '#94a3b8' },
    { name: 'Fazendo', color: '#a78bfa' },
    { name: 'Feito', color: '#2dd4bf', kind: 'done' },
  ];
  let order = 0;
  for (const d of defaults) {
    const kind = d.kind ?? 'open';
    await db.column.push({
      boardId: board.id, name: d.name, color: d.color, order: order++,
      kind, closed: kind !== 'open',
    });
  }
  await dispatchEvent('tasks:board_created', board);
  return board;
}

async function handleUpdateBoard(id, changes = {}) {
  const db = getProxy('tasks');
  const board = db.board[id];
  if (!board) throw new Error(`Board ${id} não encontrado`);
  if (changes.name !== undefined) board.name = changes.name;
  if (changes.color !== undefined) board.color = changes.color;
  if (changes.order !== undefined) board.order = changes.order;
  await dispatchEvent('tasks:board_updated', { id, changes });
  return board;
}

async function handleReorderBoards(ids = []) {
  const db = getProxy('tasks');
  ids.forEach((id, index) => {
    const board = db.board[id];
    if (board) board.order = index;
  });
  return { success: true };
}

async function handleDeleteBoard(id) {
  const db = getProxy('tasks');
  const board = db.board[id];
  if (!board) throw new Error(`Board ${id} não encontrado`);
  const remaining = db.board.query({});
  if (remaining.length <= 1) throw new Error('Não é possível excluir o último board');

  const columns = db.column.query({ boardId: id });
  const removedTaskIds = [];
  for (const col of columns) {
    const tasks = db.task.query({ columnId: col.id });
    for (const t of tasks) {
      removedTaskIds.push(t.id);
      await db.task.delete(t.id);
    }
    await db.column.delete(col.id);
  }
  await db.board.delete(id);
  scheduleTaskDelete(removedTaskIds);
  await dispatchEvent('tasks:board_deleted', { id });
  return { deleted: true, id };
}

/* ───────── Columns ───────── */

async function handleListColumns(boardId) {
  await ensureSeeded();
  const db = getProxy('tasks');
  const where = boardId ? { boardId } : {};
  return db.column.query(where, { sort: 'order ASC' });
}

async function handleCreateColumn(data = {}) {
  if (!data.boardId) throw new Error('boardId é obrigatório');
  if (!data.name) throw new Error('name é obrigatório');
  const db = getProxy('tasks');
  const siblings = db.column.query({ boardId: data.boardId });
  const kind = ['done', 'cancelled'].includes(data.kind) ? data.kind : 'open';
  const column = await db.column.push({
    boardId: data.boardId,
    name: data.name,
    color: data.color ?? '#94a3b8',
    order: siblings.length,
    // Colunas terminais (done/cancelled) nascem fechadas por padrão.
    closed: data.closed ?? kind !== 'open',
    kind,
    automation: ['refine', 'implement'].includes(data.automation) ? data.automation : 'none',
  });
  await dispatchEvent('tasks:column_created', column);
  return column;
}

async function handleUpdateColumn(id, changes = {}) {
  const db = getProxy('tasks');
  const column = db.column[id];
  if (!column) throw new Error(`Coluna ${id} não encontrada`);
  if (changes.name !== undefined) column.name = changes.name;
  if (changes.color !== undefined) column.color = changes.color;
  if (changes.order !== undefined) column.order = changes.order;
  if (changes.kind !== undefined) {
    const kind = ['done', 'cancelled'].includes(changes.kind) ? changes.kind : 'open';
    column.kind = kind;
    // Ao virar terminal, fecha por padrão; ao voltar a normal, reabre — a menos
    // que o próprio update também traga closed explícito.
    if (changes.closed === undefined) column.closed = kind !== 'open';
  }
  if (changes.closed !== undefined) column.closed = !!changes.closed;
  if (changes.automation !== undefined) {
    column.automation = ['refine', 'implement'].includes(changes.automation) ? changes.automation : 'none';
  }
  await dispatchEvent('tasks:column_updated', { id, changes });
  return column;
}

async function handleReorderColumns(ids = []) {
  const db = getProxy('tasks');
  ids.forEach((id, index) => {
    const column = db.column[id];
    if (column) column.order = index;
  });
  return { success: true };
}

async function handleDeleteColumn(id, moveTo) {
  const db = getProxy('tasks');
  const column = db.column[id];
  if (!column) throw new Error(`Coluna ${id} não encontrada`);

  const siblings = db.column.query({ boardId: column.boardId });
  if (siblings.length <= 1) throw new Error('Não é possível excluir a última coluna do board');

  const tasks = db.task.query({ columnId: id });
  if (tasks.length > 0) {
    const target = moveTo && db.column[moveTo] ? moveTo : siblings.find(c => c.id !== id)?.id;
    if (!target) throw new Error('Nenhuma coluna de destino disponível para mover as tasks');
    const destTasks = db.task.query({ columnId: target });
    let order = destTasks.length;
    for (const t of tasks) {
      t.columnId = target;
      t.order = order++;
    }
  }

  await db.column.delete(id);
  await dispatchEvent('tasks:column_deleted', { id, movedTo: tasks.length ? moveTo : null });
  return { deleted: true, id };
}

/* ───────── Estado terminal da coluna ─────────
 * Cada coluna tem um kind: "open" (normal), "done" (finalizado) ou "cancelled".
 * done/cancelled são terminais — entrar neles conclui/cancela a task. É
 * independente de `closed`, que é só visibilidade (coluna colapsada na UI),
 * embora colunas terminais nasçam fechadas por padrão.
 */
function columnKind(columnId) {
  if (!columnId) return 'open';
  const db = getProxy('tasks');
  const kind = db.column[columnId]?.kind;
  return ['done', 'cancelled'].includes(kind) ? kind : 'open';
}

/* ───────── Eventos de movimentação ─────────
 * columnId muda tanto no updateTask quanto no reorder (drag&drop). Este helper
 * centraliza a emissão para os dois caminhos: sempre tasks:moved, e — conforme
 * o kind da coluna de destino/origem — tasks:completed / tasks:cancelled /
 * tasks:reopened.
 */
async function emitMoveEvents(task, prevColumnId, prevBoardId) {
  if (!prevColumnId || prevColumnId === task.columnId) return;
  const db = getProxy('tasks');
  const fromCol = db.column[prevColumnId];
  const toCol = db.column[task.columnId];
  const base = {
    id: task.id,
    title: task.title,
    boardId: task.boardId,
    fromColumnId: prevColumnId,
    toColumnId: task.columnId,
    fromColumnName: fromCol?.name ?? null,
    toColumnName: toCol?.name ?? null,
  };
  if (prevBoardId && prevBoardId !== task.boardId) base.fromBoardId = prevBoardId;
  await dispatchEvent('tasks:moved', base);

  const fromKind = columnKind(prevColumnId);
  const toKind = columnKind(task.columnId);
  if (fromKind === toKind) return;
  if (toKind === 'done') await dispatchEvent('tasks:completed', base);
  else if (toKind === 'cancelled') await dispatchEvent('tasks:cancelled', base);
  else await dispatchEvent('tasks:reopened', base); // saiu de done/cancelled
}

/* ───────── Resolução de destino (mover entre boards/colunas) ─────────
 * Um destino é sempre uma coluna: o board vem dela. Aceita ids ou nomes
 * ("Fazendo", "UI") para o tool/rotas serem usáveis sem consultar ids antes.
 * Se boardId vier junto, ele precisa bater com o board da coluna — sem isso dá
 * para deixar a task num board com columnId de outro (estado órfão: a task
 * some do board de origem e não aparece no destino).
 */
function resolveColumnRef(ref, boardId) {
  const db = getProxy('tasks');
  if (!ref) return null;
  const direct = db.column[ref];
  if (direct) return direct;
  const q = String(ref).trim().toLowerCase();
  const pool = db.column.query(boardId ? { boardId } : {}, { sort: 'order ASC' });
  const matches = pool.filter(c => (c.name ?? '').trim().toLowerCase() === q);
  if (matches.length > 1) {
    throw new Error(`Coluna "${ref}" é ambígua (existe em mais de um board) — informe boardId ou o columnId`);
  }
  return matches[0] ?? null;
}

function resolveBoardRef(ref) {
  const db = getProxy('tasks');
  if (!ref) return null;
  const direct = db.board[ref];
  if (direct) return direct;
  const q = String(ref).trim().toLowerCase();
  return db.board.query({}).find(b => (b.name ?? '').trim().toLowerCase() === q) ?? null;
}

/* Resolve { board, column } de destino a partir de refs soltas (id ou nome).
 * Devolve null quando não há nada para mover (nenhuma ref informada).
 */
function resolveTarget({ board: boardRef, column: columnRef, defaultBoardId } = {}) {
  const db = getProxy('tasks');
  let board = null;
  if (boardRef) {
    board = resolveBoardRef(boardRef);
    if (!board) throw new Error(`Board "${boardRef}" não encontrado (use listBoards)`);
  }

  if (!columnRef) {
    if (!board) return null;
    // Só o board: cai na primeira coluna aberta dele (destino natural).
    const columns = db.column.query({ boardId: board.id }, { sort: 'order ASC' });
    const column = columns.find(c => c.kind !== 'done' && c.kind !== 'cancelled') ?? columns[0];
    if (!column) throw new Error(`Board "${board.name}" não tem colunas`);
    return { board, column };
  }

  // Sem board explícito, um nome de coluna ("Fazendo") é procurado primeiro no
  // board atual da task — nomes padrão se repetem entre boards, e mover dentro
  // do próprio board é o caso comum. Só depois a busca abre para todos (e aí
  // sim reclama se for ambíguo).
  let column = null;
  if (!board && defaultBoardId) column = resolveColumnRef(columnRef, defaultBoardId);
  if (!column) column = resolveColumnRef(columnRef, board?.id);
  if (!column) {
    const where = board ? ` no board "${board.name}"` : '';
    throw new Error(`Coluna "${columnRef}" não encontrada${where} (use listBoards)`);
  }
  if (board && column.boardId !== board.id) {
    throw new Error(`Coluna "${column.name}" não pertence ao board "${board.name}"`);
  }
  const owner = board ?? db.board[column.boardId];
  if (!owner) throw new Error(`Coluna "${column.name}" aponta para um board inexistente`);
  return { board: owner, column };
}

/* Move a task para uma coluna (de qualquer board), reindexando origem e
 * destino. position = índice desejado no destino (default: fim da coluna).
 */
async function applyMove(task, target, position) {
  const db = getProxy('tasks');
  const prevColumnId = task.columnId;
  const prevBoardId = task.boardId;
  if (target.column.id === prevColumnId && position === undefined) return { moved: false };

  const dest = db.task
    .query({ columnId: target.column.id })
    .filter(t => t.id !== task.id)
    .sort((a, b) => a.order - b.order);
  const at = position === undefined || position === null
    ? dest.length
    : Math.min(Math.max(0, parseInt(position, 10) || 0), dest.length);

  task.boardId = target.board.id;
  task.columnId = target.column.id;

  const ordered = [...dest.slice(0, at), task, ...dest.slice(at)];
  ordered.forEach((t, i) => { if (t.order !== i) t.order = i; });

  // Origem: fecha o buraco deixado pela task que saiu.
  if (prevColumnId && prevColumnId !== target.column.id) {
    db.task
      .query({ columnId: prevColumnId })
      .sort((a, b) => a.order - b.order)
      .forEach((t, i) => { if (t.order !== i) t.order = i; });
  }

  await emitMoveEvents(task, prevColumnId, prevBoardId);
  scheduleTaskIndex(task);
  return { moved: true, prevColumnId, prevBoardId };
}

async function handleMoveTask(id, input = {}) {
  const db = getProxy('tasks');
  const task = db.task[id];
  if (!task) throw new Error(`Task ${id} não encontrada`);

  const target = resolveTarget({
    board: input.boardId ?? input.board ?? input.toBoardId ?? input.toBoard,
    column: input.columnId ?? input.column ?? input.toColumnId ?? input.toColumn,
    defaultBoardId: task.boardId,
  });
  if (!target) throw new Error('Informe o board e/ou a coluna de destino');

  const from = {
    boardId: task.boardId,
    columnId: task.columnId,
    board: db.board[task.boardId]?.name ?? null,
    column: db.column[task.columnId]?.name ?? null,
  };
  const { moved } = await applyMove(task, target, input.position);

  return {
    moved,
    id: task.id,
    title: task.title,
    from,
    to: {
      boardId: target.board.id,
      columnId: target.column.id,
      board: target.board.name,
      column: target.column.name,
    },
    task: stripLegacy(task),
  };
}

/* ───────── Tasks ───────── */

async function handleCreateTask(input) {
  const data = input?.data ?? input ?? {};
  if (!data.boardId) throw new Error('boardId é obrigatório');
  if (!data.columnId) throw new Error('columnId é obrigatório');
  if (!data.title) throw new Error('title é obrigatório');

  const db = getProxy('tasks');
  const siblings = db.task.query({ columnId: data.columnId });
  const task = await db.task.push({
    boardId: data.boardId,
    columnId: data.columnId,
    title: data.title,
    description: data.description ?? null,
    priority: data.priority ?? 'medium',
    order: data.order ?? siblings.length,
    dueDate: data.dueDate ?? null,
    tags: data.tags != null ? serializeTags(data.tags) : null,
    resolution: data.resolution ?? null,
    dueNotifiedAt: null,
    status: LEGACY_STATUS,
  });
  await dispatchEvent('tasks:created', stripLegacy(task));
  scheduleTaskIndex(task);
  return stripLegacy(task);
}

async function handleUpdateTask(id, changes = {}) {
  const db = getProxy('tasks');
  const task = db.task[id];
  if (!task) throw new Error(`Task ${id} não encontrada`);

  // O modal do board devolve o formulário inteiro no save (TaskModal.svelte),
  // então a presença de uma chave em `changes` não significa que algo mudou.
  // Guardamos o estado anterior para calcular changedFields por diferença de
  // valor — é isso que permite a um flow reagir só ao que de fato mudou.
  const before = stripLegacy(task);

  // Board/coluna passam pelo resolver: garante que a coluna existe e pertence ao
  // board informado (senão a task ficaria órfã entre os dois boards), e o
  // reordena origem/destino. O resto dos campos é atribuição direta.
  // Um boardId igual ao atual sem columnId não é uma movimentação (o modal
  // manda o board junto em todo save) — só resolve quando algo muda de fato.
  const wantsMove = changes.columnId !== undefined
    || (changes.boardId !== undefined && changes.boardId !== task.boardId);
  const target = wantsMove
    ? resolveTarget({ board: changes.boardId, column: changes.columnId, defaultBoardId: task.boardId })
    : null;

  if (changes.title !== undefined) task.title = changes.title;
  if (changes.description !== undefined) task.description = changes.description;
  if (changes.priority !== undefined) task.priority = changes.priority;
  if (changes.order !== undefined && !target) task.order = changes.order;
  if (changes.dueDate !== undefined) {
    task.dueDate = changes.dueDate;
    task.dueNotifiedAt = null; // novo vencimento → volta a poder emitir tasks:due
  }
  if (changes.tags !== undefined) task.tags = serializeTags(changes.tags);
  if (changes.resolution !== undefined) task.resolution = changes.resolution;

  // A movimentação é aplicada ANTES de anunciar o update: `columnId` só muda
  // dentro de applyMove, então disparar antes faria o payload anunciar a coluna
  // antiga — e changedFields nunca acusaria a mudança de coluna. O preço é que
  // tasks:moved/completed/cancelled saem antes de tasks:updated.
  if (target) await applyMove(task, target, changes.order);

  // Além de { id, changes } (mantido por compat), o evento leva o estado atual
  // da task e os campos alterados. Sem isso um flow em tasks:updated não tem
  // como decidir nada: não sabe o board, a coluna, nem o que de fato mudou.
  // changedFields vai como string (csv) para caber no shape absorvido do flows,
  // que só guarda tipos de 1º nível.
  const after = stripLegacy(task);
  const changedFields = Object.keys(after)
    .filter(k => before[k] !== after[k]);
  await dispatchEvent('tasks:updated', {
    ...after,
    id,
    changes,
    changedFields: changedFields.join(','),
    columnName: db.column[task.columnId]?.name ?? null,
  });
  scheduleTaskIndex(task);
  return after;
}

async function handleListTasks(filters = {}) {
  await ensureSeeded();
  const db = getProxy('tasks');
  const where = {};
  if (filters.boardId) where.boardId = filters.boardId;
  if (filters.columnId) where.columnId = filters.columnId;
  if (filters.priority) where.priority = filters.priority;
  const options = { sort: filters.sort || 'order ASC' };
  if (filters.limit) options.limit = parseInt(filters.limit);
  let tasks = db.task.query(where, options);
  if (filters.tag) {
    const tag = String(filters.tag).toLowerCase();
    tasks = tasks.filter(task => parseTags(task.tags).some(value => String(value).toLowerCase() === tag));
  }
  const semanticIds = await searchTaskIds(filters.search);
  if (semanticIds) {
    const rank = new Map(semanticIds.map((id, index) => [id, index]));
    tasks = tasks.filter(task => rank.has(task.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  } else if (filters.search) {
    const query = String(filters.search).toLowerCase();
    tasks = tasks.filter(task =>
      (task.title ?? '').toLowerCase().includes(query) || (task.description ?? '').toLowerCase().includes(query));
  }
  return tasks.map(stripLegacy);
}

async function handleGetTask(id) {
  const db = getProxy('tasks');
  const task = db.task[id];
  if (!task) throw new Error(`Task ${id} não encontrada`);
  return stripLegacy(task);
}

async function handleDeleteTask(id) {
  const db = getProxy('tasks');
  const task = db.task[id];
  if (!task) throw new Error(`Task ${id} não encontrada`);
  for (const c of db.comment.query({ taskId: id })) await db.comment.delete(c.id);
  await db.task.delete(id);
  scheduleTaskDelete([id]);
  await dispatchEvent('tasks:deleted', { id });
  return { deleted: true, id };
}

async function handleReorderTasks(columnId, ids = []) {
  const db = getProxy('tasks');
  const column = db.column[columnId];
  if (!column) throw new Error(`Coluna ${columnId} não encontrada`);
  const moved = [];
  ids.forEach((id, index) => {
    const task = db.task[id];
    if (task) {
      const prevColumnId = task.columnId;
      const prevBoardId = task.boardId;
      task.columnId = columnId;
      // A coluna manda no board: um drop numa coluna de outro board leva a task
      // junto, em vez de deixá-la apontando para o board antigo.
      if (task.boardId !== column.boardId) task.boardId = column.boardId;
      task.order = index;
      if (prevColumnId !== columnId) moved.push({ task, prevColumnId, prevBoardId });
    }
  });
  for (const { task, prevColumnId, prevBoardId } of moved) {
    await emitMoveEvents(task, prevColumnId, prevBoardId);
  }
  return { success: true };
}

/* ───────── Comentários ─────────
 * Thread simples por task (sem edição): criar, listar, apagar. Cada criação vira
 * um evento no bus e, por tabela, chega ao vivo em quem estiver com o board
 * aberto (ver a ponte SSE no fim do arquivo).
 */

function commentJSON(c) {
  return {
    id: c.id,
    taskId: c.taskId,
    author: c.author || 'user',
    content: c.content,
    createdAt: c.createdAt,
  };
}

async function handleListComments(taskId) {
  const db = getProxy('tasks');
  return db.comment.query({ taskId }, { sort: 'createdAt ASC' }).map(commentJSON);
}

async function handleCreateComment(taskId, data = {}) {
  const db = getProxy('tasks');
  const task = db.task[taskId];
  if (!task) throw new Error(`Task ${taskId} não encontrada`);
  const content = String(data.content ?? '').trim();
  if (!content) throw new Error('content é obrigatório');
  const comment = await db.comment.push({
    taskId,
    author: data.author || 'user',
    content,
  });
  await dispatchEvent('tasks:comment_added', {
    id: comment.id, taskId, boardId: task.boardId, author: comment.author, content,
  });
  return commentJSON(comment);
}

async function handleDeleteComment(id) {
  const db = getProxy('tasks');
  const comment = db.comment[id];
  if (!comment) throw new Error(`Comentário ${id} não encontrado`);
  const taskId = comment.taskId;
  await db.comment.delete(id);
  await dispatchEvent('tasks:comment_deleted', { id, taskId });
  return { deleted: true, id };
}

async function handleTaskContext(id) {
  const db = getProxy('tasks');
  const task = db.task[id];
  if (!task) throw new Error(`Task ${id} não encontrada`);
  return {
    taskId: id,
    comments: await handleListComments(id),
  };
}

/* ───────── Tools (uso pelo assistente via chat) ─────────
 * O tool listTasks NÃO devolve descrições inteiras: cada task vira uma linha
 * compacta (título, board/coluna por nome, preview da descrição) — descrição
 * completa é papel do getTask. O bridge MCP achata os argumentos em chaves
 * pontilhadas ("filters.board"); unflatten() aceita as três formas possíveis
 * (achatada, aninhada e solta) para os filtros funcionarem em todas.
 */

function unflatten(input, ns) {
  const flat = input ?? {};
  const nested = flat[ns] && typeof flat[ns] === 'object' ? flat[ns] : {};
  const out = { ...nested };
  const prefix = `${ns}.`;
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    else if (k !== ns && !k.includes('.') && out[k] === undefined) out[k] = v;
  }
  return out;
}

// tags é TEXT com JSON — e há linhas legadas double-encoded (gravadas antes do
// serializeTags) ou separadas por vírgula, então desembrulha até 3 níveis e cai
// no split como último recurso.
function parseTags(raw) {
  let v = raw;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    const trimmed = v.trim();
    if (!trimmed) return [];
    if (trimmed[0] !== '[' && trimmed[0] !== '"') return splitTags(trimmed);
    try { v = JSON.parse(trimmed); } catch { return splitTags(trimmed); }
  }
  if (typeof v === 'string') return splitTags(v);
  return Array.isArray(v) ? v.map(t => String(t).trim()).filter(Boolean) : [];
}

function splitTags(text) {
  return text.split(',').map(t => t.trim()).filter(Boolean);
}

// Uma única serialização, sempre a partir de um array normalizado: aceitar uma
// string aqui e stringificá-la direto é o que produzia o double-encoding.
function serializeTags(value) {
  return JSON.stringify(parseTags(value));
}

function preview(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function listBoards() {
  /**
   * @register_tool listBoards
   * @description Lista os boards com suas colunas (id + nome) e contagem de tasks por coluna — o mapa para navegar/mover tasks
   */
  return (async () => {
    const boards = await handleListBoards();
    const db = getProxy('tasks');
    const tasks = db.task.query({});
    const countByColumn = {};
    for (const t of tasks) countByColumn[t.columnId] = (countByColumn[t.columnId] ?? 0) + 1;
    return boards.map(b => ({
      id: b.id,
      name: b.name,
      color: b.color,
      columns: db.column.query({ boardId: b.id }, { sort: 'order ASC' })
        .map(c => ({ id: c.id, name: c.name, tasks: countByColumn[c.id] ?? 0 })),
    }));
  })();
}

export function createTask(data) {
  /**
   * @register_tool createTask
   * @description Cria uma nova tarefa em um board/coluna
   * @param {object} data - { boardId, columnId, title, description?, priority?, dueDate?, tags? }
   */
  return handleCreateTask(data);
}

export function createTaskFromText(input) {
  /**
   * @register_tool createTaskFromText
   * @description Cria uma task a partir de uma descrição solta em linguagem natural — uma única chamada de LLM classifica (board/coluna/título/descrição/prioridade), sem tool-calling; a criação em si é feita direto em JS.
   * @param {object} input - { text: string }
   */
  const text = (input?.text ?? input ?? '').toString().trim();
  if (!text) throw new Error('Campo "text" é obrigatório');

  return (async () => {
    const boards = await listBoards();
    const boardsList = boards
      .map((b) => `- ${b.name} (boardId: ${b.id}) — colunas: ${b.columns.map((c) => `${c.name} (columnId: ${c.id})`).join(', ')}`)
      .join('\n');

    // Sem tools/ReAct: uma única chamada de LLM só classifica o texto num
    // JSON. A criação (createTask) é feita aqui em JS, determinística — não
    // depende do modelo "lembrar" de chamar a tool certa.
    const result = await runAgentTask({
      system: `Você classifica uma descrição solta de usuário como uma task de Kanban.
Boards e colunas disponíveis:
${boardsList}

Escolha o board/coluna mais adequado (normalmente a coluna "Backlog" do board mais
relevante ao assunto), usando os ids EXATOS listados acima. Escreva um título curto e
objetivo, uma descrição completa (pode reorganizar/expandir o texto do usuário) e uma
prioridade (low/medium/high/urgent). Responda SOMENTE com o JSON pedido, nada de prosa.`,
      goal: text,
      tools: [],
      maxSteps: 1,
      outputSchema: {
        type: 'object',
        properties: {
          boardId: { type: 'string' },
          columnId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string' },
        },
        required: ['boardId', 'columnId', 'title'],
      },
    });
    if (!result.success) throw new Error(result.error || 'não foi possível classificar a task');

    const { boardId, columnId, title, description, priority } = result.output;
    const board = boards.find((b) => b.id === boardId);
    const column = board?.columns.find((c) => c.id === columnId);
    if (!board || !column) throw new Error('LLM escolheu board/coluna inválidos');

    const task = await handleCreateTask({ boardId, columnId, title, description, priority });
    return { board: board.name, column: column.name, title: task.title, taskId: task.id };
  })();
}

export function listTasks(input) {
  /**
   * @register_tool listTasks
   * @description Lista tarefas em formato compacto (uma linha por task, com preview da descrição) ordenadas por atualização recente. Use getTask(id) para ler uma descrição completa e os filtros para restringir — evite listar tudo sem filtro.
   * @param {string?} filters.board - Board por nome (ex: "UI") ou id
   * @param {string?} filters.column - Coluna por nome (ex: "Fazendo") ou id
   * @param {string?} filters.search - Busca textual em título e descrição
   * @param {string?} filters.tag - Filtrar por tag exata
   * @param {string?} filters.priority - Filtrar por prioridade: low, medium, high, urgent
   * @param {number?} filters.limit - Máximo de resultados (default 30 compacto, 10 full)
   * @param {number?} filters.offset - Pula N resultados (paginação; veja nextOffset na resposta)
   * @param {boolean?} filters.full - Devolve as tasks completas (descrição inteira), com limite menor
   * @param {boolean?} filters.count - Devolve só contagens por board/coluna, sem tasks
   */
  return (async () => {
    await ensureSeeded();
    const f = unflatten(input, 'filters');
    const db = getProxy('tasks');
    const boards = db.board.query({}, { sort: 'order ASC' });
    const allColumns = db.column.query({});
    const boardById = new Map(boards.map(b => [b.id, b]));
    const columnById = new Map(allColumns.map(c => [c.id, c]));

    let boardId = f.boardId;
    const boardRef = boardId ?? f.board;
    if (!boardId && boardRef) {
      const q = String(boardRef).toLowerCase();
      const match = boardById.get(boardRef) ?? boards.find(b => (b.name ?? '').toLowerCase() === q);
      if (!match) throw new Error(`Board "${boardRef}" não encontrado (use listBoards para ver os nomes)`);
      boardId = match.id;
    }

    let columnIds = null;
    const columnRef = f.columnId ?? f.column;
    if (columnRef) {
      if (columnById.has(columnRef)) {
        columnIds = new Set([columnRef]);
      } else {
        const q = String(columnRef).toLowerCase();
        const matches = allColumns.filter(c =>
          (c.name ?? '').toLowerCase() === q && (!boardId || c.boardId === boardId));
        if (matches.length === 0) throw new Error(`Coluna "${columnRef}" não encontrada (use listBoards para ver os nomes)`);
        columnIds = new Set(matches.map(c => c.id));
      }
    }

    let tasks = db.task.query(boardId ? { boardId } : {}, { sort: f.sort || 'updatedAt DESC' });
    if (columnIds) tasks = tasks.filter(t => columnIds.has(t.columnId));
    if (f.priority) tasks = tasks.filter(t => t.priority === f.priority);
    if (f.tag) {
      const q = String(f.tag).toLowerCase();
      tasks = tasks.filter(t => parseTags(t.tags).some(tag => String(tag).toLowerCase() === q));
    }
    const semanticIds = await searchTaskIds(f.search);
    if (semanticIds) {
      const rank = new Map(semanticIds.map((id, index) => [id, index]));
      tasks = tasks.filter(t => rank.has(t.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    } else if (f.search) {
      const q = String(f.search).toLowerCase();
      tasks = tasks.filter(t =>
        (t.title ?? '').toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
    }

    const locate = t => ({
      board: boardById.get(t.boardId)?.name ?? null,
      column: columnById.get(t.columnId)?.name ?? null,
    });

    if (f.count === true || f.count === 'true') {
      const byBoard = {};
      for (const t of tasks) {
        const { board, column } = locate(t);
        const entry = (byBoard[board ?? '(sem board)'] ??= { total: 0, columns: {} });
        entry.total += 1;
        const col = column ?? '(sem coluna)';
        entry.columns[col] = (entry.columns[col] ?? 0) + 1;
      }
      return { total: tasks.length, boards: byBoard };
    }

    const full = f.full === true || f.full === 'true';
    const offset = Math.max(0, parseInt(f.offset, 10) || 0);
    const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || (full ? 10 : 30)), full ? 50 : 200);
    const page = tasks.slice(offset, offset + limit);

    const rows = page.map(t => {
      const { board, column } = locate(t);
      if (full) return { ...stripLegacy(t), board, column, tags: parseTags(t.tags) };
      const description = String(t.description ?? '');
      const row = {
        id: t.id,
        title: t.title,
        board,
        column,
        priority: t.priority,
        tags: parseTags(t.tags),
        updatedAt: t.updatedAt,
      };
      if (t.dueDate) row.dueDate = t.dueDate;
      if (t.resolution) row.resolution = preview(t.resolution, 80);
      if (description) {
        row.preview = preview(description, 110);
        row.descriptionChars = description.length;
      }
      return row;
    });

    const out = { total: tasks.length, offset, showing: rows.length, tasks: rows };
    if (tasks.length > offset + rows.length) out.nextOffset = offset + rows.length;
    return out;
  })();
}

export function getTask(input) {
  /**
   * @register_tool getTask
   * @description Obtém uma tarefa completa pelo ID (descrição inteira + nomes de board/coluna)
   * @param {string} data.id - ID da tarefa
   */
  const flat = input ?? {};
  const id = flat['data.id'] ?? flat.id ?? flat.data?.id ?? flat;
  return (async () => {
    const task = await handleGetTask(id);
    const db = getProxy('tasks');
    return {
      ...task,
      board: db.board[task.boardId]?.name ?? null,
      column: db.column[task.columnId]?.name ?? null,
      tags: parseTags(task.tags),
    };
  })();
}

export function updateTask(input) {
  /**
   * @register_tool updateTask
   * @description Atualiza campos de uma tarefa
   * @param {string} data.id - ID da tarefa
   * @param {string?} data.title - Novo título
   * @param {string?} data.description - Nova descrição
   * @param {string?} data.columnId - Nova coluna (para mover entre boards prefira moveTask)
   * @param {string?} data.priority - Nova prioridade: low, medium, high, urgent
   * @param {string[]?} data.tags - Novo array de tags
   */
  const flat = input ?? {};
  const id = flat['data.id'] ?? flat.id ?? flat.data?.id;
  const changes = {};
  const keys = ['title', 'description', 'boardId', 'columnId', 'priority', 'dueDate', 'tags', 'resolution'];
  for (const k of keys) {
    const v = flat[`data.${k}`] ?? flat[k] ?? flat.data?.[k];
    if (v !== undefined) changes[k] = v;
  }
  return handleUpdateTask(id, changes);
}

export function moveTask(input) {
  /**
   * @register_tool moveTask
   * @description Move uma tarefa para outra coluna — do mesmo board ou de outro board. Aceita nomes ("Fazendo", "UI") ou ids; se só o board for informado, cai na primeira coluna aberta dele.
   * @param {string} data.id - ID da tarefa
   * @param {string?} data.board - Board de destino por nome ou id (opcional se a coluna for informada por id)
   * @param {string?} data.column - Coluna de destino por nome ou id
   * @param {number?} data.position - Posição na coluna de destino (0 = topo; default: fim)
   */
  const flat = input ?? {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = flat[`data.${k}`] ?? flat[k] ?? flat.data?.[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const id = pick('id', 'taskId');
  if (!id) throw new Error('Campo "id" é obrigatório');
  return handleMoveTask(id, {
    board: pick('board', 'boardId', 'toBoard', 'toBoardId'),
    column: pick('column', 'columnId', 'toColumn', 'toColumnId'),
    position: pick('position'),
  });
}

export function addTaskComment(input) {
  /**
   * @register_tool addTaskComment
   * @description Comenta numa task. O comentário aparece ao vivo para quem estiver com o board aberto.
   * @param {string} data.id - ID da tarefa
   * @param {string} data.content - Texto do comentário
   * @param {string?} data.author - Quem comentou (default "agent" quando vem do assistente)
   */
  const flat = input ?? {};
  const pick = k => flat[`data.${k}`] ?? flat[k] ?? flat.data?.[k];
  const id = pick('id') ?? pick('taskId');
  if (!id) throw new Error('Campo "id" é obrigatório');
  return handleCreateComment(id, { content: pick('content'), author: pick('author') || 'agent' });
}

export function getTaskContext(input) {
  /**
   * @register_tool getTaskContext
   * @description Contexto de uma tarefa, incluindo seus comentários.
   * @param {string} data.id - ID da tarefa
   */
  const flat = input ?? {};
  const id = flat['data.id'] ?? flat.id ?? flat.data?.id;
  return handleTaskContext(id);
}

export function deleteTask(input) {
  /**
   * @register_tool deleteTask
   * @description Remove uma tarefa (soft delete)
   * @param {string} data.id - ID da tarefa
   */
  const flat = input ?? {};
  const id = flat['data.id'] ?? flat.id ?? flat.data?.id;
  return handleDeleteTask(id);
}

/* ───────── Rotas HTTP ───────── */

// Boards
export function routerListBoards(req, res) {
  /** @register_router boards
   *  @method GET */
  return handleListBoards();
}
export function routerCreateBoard(req, res) {
  /** @register_router boards
   *  @method POST */
  return handleCreateBoard(req.body);
}
export function routerReorderBoards(req, res) {
  /** @register_router boards/reorder
   *  @method POST */
  return handleReorderBoards(req.body?.ids || []);
}
export function routerUpdateBoard(req, res) {
  /** @register_router boards/:id
   *  @method PATCH */
  return handleUpdateBoard(req.params.id, req.body);
}
export function routerDeleteBoard(req, res) {
  /** @register_router boards/:id
   *  @method DELETE */
  return handleDeleteBoard(req.params.id);
}

// Columns
export function routerListColumns(req, res) {
  /** @register_router columns
   *  @method GET */
  return handleListColumns(req.query.boardId);
}
export function routerCreateColumn(req, res) {
  /** @register_router columns
   *  @method POST */
  return handleCreateColumn(req.body);
}
export function routerReorderColumns(req, res) {
  /** @register_router columns/reorder
   *  @method POST */
  return handleReorderColumns(req.body?.ids || []);
}
export function routerUpdateColumn(req, res) {
  /** @register_router columns/:id
   *  @method PATCH */
  return handleUpdateColumn(req.params.id, req.body);
}
export function routerDeleteColumn(req, res) {
  /** @register_router columns/:id
   *  @method DELETE */
  return handleDeleteColumn(req.params.id, req.query.moveTo);
}

// Tasks
export function routerListTasks(req, res) {
  /** @register_router tasks
   *  @method GET */
  return handleListTasks(req.query);
}
export function routerCreateTask(req, res) {
  /** @register_router tasks
   *  @method POST */
  return handleCreateTask(req.body);
}
export function routerCreateTaskFromText(req, res) {
  /** @register_router create-from-text
   *  @method POST */
  return createTaskFromText(req.body);
}
export function routerReorderTasks(req, res) {
  /** @register_router tasks/reorder
   *  @method POST */
  return handleReorderTasks(req.body?.columnId, req.body?.ids || []);
}
export function routerMoveTask(req, res) {
  /** @register_router tasks/:id/move
   *  @method POST */
  return handleMoveTask(req.params.id, req.body || {});
}
export function routerGetTask(req, res) {
  /** @register_router tasks/:id
   *  @method GET */
  return handleGetTask(req.params.id);
}
export function routerUpdateTask(req, res) {
  /** @register_router tasks/:id
   *  @method PATCH */
  return handleUpdateTask(req.params.id, req.body);
}
export function routerDeleteTask(req, res) {
  /** @register_router tasks/:id
   *  @method DELETE */
  return handleDeleteTask(req.params.id);
}

// Comentários
export function routerListComments(req, res) {
  /** @register_router tasks/:id/comments
   *  @method GET */
  return handleListComments(req.params.id);
}
export function routerCreateComment(req, res) {
  /** @register_router tasks/:id/comments
   *  @method POST */
  return handleCreateComment(req.params.id, req.body || {});
}
export function routerDeleteComment(req, res) {
  /** @register_router comments/:id
   *  @method DELETE */
  return handleDeleteComment(req.params.id);
}

// Contexto
export function routerTaskContext(req, res) {
  /** @register_router tasks/:id/context
   *  @method GET */
  return handleTaskContext(req.params.id);
}
/* ───────── Stream ao vivo (SSE) ─────────
 * Mexeu no board — por drag na UI, por tool do assistente ou por outra aba —
 * todo mundo que estiver olhando vê na hora.
 *
 * O bus já tinha todos os eventos; faltava a ponte até o navegador. Aqui ela é
 * feita uma única vez (guarda em globalThis, porque o runtime re-executa o
 * módulo a cada hot-reload e as inscrições se acumulariam), com fan-out para as
 * conexões abertas.
 *
 * IMPORTANTE: dispatchEvent roda os handlers como PIPELINE — o retorno do
 * handler substitui o payload do próximo. Os handlers daqui não retornam nada.
 */
// As conexões abertas sobrevivem ao hot-reload (ficam em globalThis); as
// inscrições no bus, não. Duas armadilhas aprendidas aqui:
//
//   1. O hook `boot` NÃO roda a cada hot-reload (só no boot do processo) — ligar
//      o stream lá deixava o board mudo depois do primeiro swap. Por isso a
//      inscrição acontece no CARREGAMENTO do módulo, no fim deste arquivo.
//   2. Inscrever com `owner: 'tasks'` também não serve: o runtime chama
//      removeOwner('<pacote>') ao re-wirar o pacote, e derrubaria justamente
//      estas inscrições. Elas ficam sem owner, e a duplicação é evitada pelos
//      `off` guardados aqui (mesmo padrão do package flows).
const STREAM = (globalThis.__tasksStream ??= { clients: new Set(), offs: [] });

const STREAMED_EVENTS = [
  'tasks:created', 'tasks:updated', 'tasks:deleted', 'tasks:moved',
  'tasks:completed', 'tasks:cancelled', 'tasks:reopened', 'tasks:due',
  'tasks:comment_added', 'tasks:comment_deleted',
  'tasks:board_created', 'tasks:board_updated', 'tasks:board_deleted',
  'tasks:column_created', 'tasks:column_updated', 'tasks:column_deleted',
];

function broadcastToStream(event, payload) {
  for (const res of STREAM.clients) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`);
    } catch {
      STREAM.clients.delete(res);
    }
  }
}

function wireStream() {
  for (const off of STREAM.offs) { try { off(); } catch { /* já removida no swap */ } }
  STREAM.offs = STREAMED_EVENTS.map(event =>
    on(event, payload => { broadcastToStream(event, payload); }));
}

export function routerEvents(req, res) {
  /** @register_router events
   *  @method GET
   *  @streaming
   *
   *  @streaming é obrigatório: sem ele o runtime serializa o retorno do handler
   *  e encerra a resposta (res.json) assim que ele volta — a conexão SSE morreria
   *  no primeiro byte. Com a flag, quem escreve na resposta é este handler. */
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  STREAM.clients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ events: STREAMED_EVENTS })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); STREAM.clients.delete(res); }
  }, 30_000);

  const close = () => { clearInterval(heartbeat); STREAM.clients.delete(res); };
  req.on('close', close);
  req.on('error', close);
}

/* ───────── Wiring no carregamento do módulo ─────────
 * Roda no boot E em cada hot-reload (ao contrário do hook `boot`, que só é
 * chamado quando o processo sobe). É o que mantém o stream vivo depois de o
 * pacote ser editado — sem isto o board ficava mudo até reiniciar o runtime.
 */
wireStream();

/* ───────── Varredura de vencimento ─────────
 * Emite tasks:due uma única vez por vencimento (marca dueNotifiedAt). Tasks em
 * colunas "closed" (concluídas) são ignoradas — não faz sentido cobrar prazo do
 * que já terminou. Roda no boot e a cada DUE_SCAN_INTERVAL_MS.
 */
const DUE_SCAN_INTERVAL_MS = 5 * 60 * 1000;
let _dueTimer = null;

export async function provideAgentContext(payload = {}) {
  /**
   * @register_hook tasks:agent-context
   */
  await ensureSeeded();
  const db = getProxy('tasks');
  const tasks = db.task.query({});
  const candidates = await findDialogueCandidates(payload.message, tasks);
  return {
    ...buildAgentContext({
      tasks,
      boards: db.board.query({}, { sort: 'order ASC' }),
      columns: db.column.query({}, { sort: 'order ASC' }),
    }),
    request: payload.message ?? '',
    agent: payload.agent ?? 'Tasks',
    relatedTasks: candidates,
  };
}

async function scanDueTasks() {
  const db = getProxy('tasks');
  const now = Date.now();
  const tasks = db.task.query({});
  for (const task of tasks) {
    if (!task.dueDate || task.dueNotifiedAt) continue;
    const due = Date.parse(task.dueDate);
    if (Number.isNaN(due) || due > now) continue;
    if (columnKind(task.columnId) !== 'open') continue; // já finalizada/cancelada
    task.dueNotifiedAt = new Date(now).toISOString();
    await dispatchEvent('tasks:due', {
      id: task.id,
      title: task.title,
      boardId: task.boardId,
      columnId: task.columnId,
      dueDate: task.dueDate,
      priority: task.priority,
    });
  }
}

export function onBoot() {
  /**
   * @register_hook boot
   */
  ensureSeeded()
    .then(() => {
      console.log('[tasks] Package carregado com sucesso.');
      const db = getProxy('tasks');
      const documents = db.task.query({}).map(taskEmbeddingDocument).filter(document => document.content);
      if (documents.length) {
        void dispatchEvent('embeddings:upsert', {
          collection: TASK_EMBEDDINGS_COLLECTION,
          documents,
        }).catch(error => console.warn('[tasks] backfill opcional falhou:', error.message));
      }
      scanDueTasks().catch(err => console.error('[tasks] Falha na varredura de vencimento:', err));
      if (!_dueTimer) {
        _dueTimer = setInterval(
          () => scanDueTasks().catch(err => console.error('[tasks] Falha na varredura de vencimento:', err)),
          DUE_SCAN_INTERVAL_MS,
        );
        if (typeof _dueTimer.unref === 'function') _dueTimer.unref();
      }
    })
    .catch(err => console.error('[tasks] Falha ao migrar dados:', err));
}
