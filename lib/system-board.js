// Regras puras do board operacional. Mantê-las fora do runtime torna o
// recorte de migração auditável e testável.

export const SYSTEM_BOARD_NAME = 'Sistema';

export const SYSTEM_COLUMNS = [
  { name: 'Backlog', color: '#94a3b8', kind: 'open' },
  { name: 'Pendente', color: '#f472b6', kind: 'open' },
  { name: 'Fazendo', color: '#a78bfa', kind: 'open' },
  { name: 'Feito', color: '#2dd4bf', kind: 'done' },
];

const OPERATION_TAGS = new Set([
  'infra', 'deploy', 'tenant-systemd', 'workloads', 'host', 'vps', 'provisioning',
]);

/**
 * O título é deliberadamente a única busca textual: evita transferir cards
 * que só citam infraestrutura como contexto. Tags são o sinal principal.
 */
export function belongsToSystemBoard({ title = '', tags = [] } = {}) {
  const normalizedTags = Array.isArray(tags) ? tags : [];
  if (normalizedTags.some(tag => OPERATION_TAGS.has(String(tag).trim().toLowerCase()))) return true;

  const normalizedTitle = String(title).trim().toLowerCase();
  return /\bfleet\b/.test(normalizedTitle)
    || (/\bdashboard\b/.test(normalizedTitle) && /\bfase\s*5\b/.test(normalizedTitle));
}
