// Leitura tolerante do campo `tags` de uma task.
//
// A API já devolve array, mas linhas legadas podem chegar como JSON string —
// inclusive double-encoded ('"[\"a\"]"'), que ao ser parseado uma vez só volta
// como string e faria a UI renderizar uma tag por caractere.

export function parseTags(raw) {
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
