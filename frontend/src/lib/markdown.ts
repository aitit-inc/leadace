// Tiny safe Markdown renderer for the inquiry landing chat. The system
// prompt tells gpt-5.4-mini it may use ONLY **bold**, *italic*, and bullet/
// numbered lists, so we deliberately support that subset and nothing else.
// Anything outside the subset (raw HTML, headings, code blocks, links,
// images, etc.) is escaped or left as plain text — never executed.
//
// Output is HTML inserted via Svelte `{@html}`. Every code path that produces
// HTML must escape user-controlled text first; the only places we emit raw
// tags (<p>, <br>, <ul>, <ol>, <li>, <strong>, <em>) are hard-coded here.

const ESCAPE_HTML: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_HTML[c] ?? c);
}

function renderInline(text: string): string {
  // Order matters: bold (**...**) MUST run before italic (*...*) so the
  // double-star wrapper isn't eaten by the single-star regex.
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  return out;
}

const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+\.\s+(.*)$/;

export function renderInquiryMarkdown(input: string): string {
  if (!input) return '';
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }

    const ulMatch = UL_RE.exec(line);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = UL_RE.exec(lines[i] ?? '');
        if (!m) break;
        items.push(`<li>${renderInline(m[1] ?? '')}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const olMatch = OL_RE.exec(line);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = OL_RE.exec(lines[i] ?? '');
        if (!m) break;
        items.push(`<li>${renderInline(m[1] ?? '')}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (cur.trim() === '') break;
      if (UL_RE.test(cur) || OL_RE.test(cur)) break;
      para.push(renderInline(cur));
      i++;
    }
    blocks.push(`<p>${para.join('<br>')}</p>`);
  }

  return blocks.join('');
}
