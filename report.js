// Renders the report (Markdown produced by the LLM), always escaping the content.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
}

const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function renderMarkdown(md) {
  const lines = (md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.max(2, heading[1].length); // the page's h1 is the title
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // table: header + |---|---| separator
    if (line.trim().startsWith('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      const head = cells(line.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i].trim())); i++; }
      out.push(
        '<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push('<ol>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ol>');
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !lines[i].trim().startsWith('|')) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    else i++;
  }

  return out.join('\n');
}

async function main() {
  const { report } = await chrome.storage.local.get('report');
  const md = document.getElementById('md');
  if (!report) {
    md.innerHTML = '<p>Todavía no hay ningún informe. Graba una conversación y pulsa «Informe de la sesión».</p>';
    return;
  }

  document.getElementById('when').textContent =
    new Date(report.at).toLocaleString('es-CO') + ` · ${report.turns} intervenciones`;
  md.innerHTML = renderMarkdown(report.markdown);

  if (report.transcript) {
    document.getElementById('raw').hidden = false;
    document.getElementById('transcript').innerHTML = renderMarkdown(report.transcript);
  }

  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(report.markdown);
    document.getElementById('copy').textContent = 'Copiado ✓';
  });

  document.getElementById('download').addEventListener('click', () => {
    const blob = new Blob([`# Informe de la sesión\n\n${report.markdown}\n\n---\n\n## Transcripción\n\n${report.transcript || ''}\n`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `informe-ingles-${new Date(report.at).toISOString().slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
}

if (typeof document !== 'undefined' && document.getElementById('md')) main();
