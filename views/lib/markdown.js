// Renderizador de Markdown do board — mesmo espírito do Notebook: escapa tudo
// primeiro (nenhum HTML do usuário sobrevive) e só depois aplica as regras, de
// modo que o resultado é sempre seguro para {@html}.

const ESCAPES = [[/&/g, '&amp;'], [/</g, '&lt;'], [/>/g, '&gt;']];

function escape(value) {
  let out = String(value ?? '');
  for (const [re, to] of ESCAPES) out = out.replace(re, to);
  return out;
}

// Blocos de código saem antes das demais regras (nada dentro deles é
// interpretado) e voltam no fim, pelos marcadores.
function extractFences(text, store) {
  return text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = store.push(`<pre class="md-pre"${lang ? ` data-lang="${lang}"` : ''}><code>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000FENCE${i}\u0000`;
  });
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Só links http(s) viram <a> — evita javascript:/data: no href.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(source) {
  const fences = [];
  const text = extractFences(escape(source), fences);

  const html = [];
  let list = null; // 'ul' | 'ol' | null

  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  const openList = kind => { if (list !== kind) { closeList(); html.push(`<${kind}>`); list = kind; } };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();

    const fence = line.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fence) { closeList(); html.push(fences[Number(fence[1])]); continue; }

    if (!line.trim()) { closeList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); html.push('<hr>'); continue; }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) { closeList(); html.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    // Checklists ("- [ ] passo") viram itens marcáveis só para leitura.
    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (check) {
      openList('ul');
      const done = check[1].toLowerCase() === 'x';
      html.push(`<li class="md-check${done ? ' done' : ''}"><span class="md-box">${done ? '✓' : ''}</span>${inline(check[2])}</li>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { openList('ul'); html.push(`<li>${inline(bullet[1])}</li>`); continue; }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) { openList('ol'); html.push(`<li>${inline(ordered[1])}</li>`); continue; }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return html.join('\n');
}

// Versão de uma linha (cards, previews): sem blocos, só o texto limpo.
export function stripMarkdown(source, max = 140) {
  const flat = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*([-*]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/[#>*_`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
