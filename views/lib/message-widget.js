const MAX_TASKS = 20;

export function parseTaskSource(source) {
  const text = String(source ?? '').trim();
  if (!text) throw new Error('Provide taskId or taskIds.');

  let payload;
  try {
    payload = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : { taskId: text };
  } catch {
    throw new Error('Invalid payload. Use JSON with taskId or taskIds.');
  }

  if (Array.isArray(payload)) payload = { taskIds: payload };
  const candidates = payload?.taskIds ?? (payload?.taskId ? [payload.taskId] : []);
  const ids = [...new Set(
    (Array.isArray(candidates) ? candidates : [candidates])
      .map(value => String(value ?? '').trim())
      .filter(Boolean),
  )];

  if (!ids.length) throw new Error('Provide taskId or taskIds.');
  if (ids.length > MAX_TASKS) throw new Error(`The widget supports at most ${MAX_TASKS} tasks.`);
  return ids;
}
