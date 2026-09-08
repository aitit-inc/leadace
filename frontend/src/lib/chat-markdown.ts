import { Marked } from 'marked';

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:'];

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return ALLOWED_PROTOCOLS.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const chatMarkdown = new Marked({
  breaks: true,
  renderer: {
    html: () => '',
    // An image URL loads without a click, and the chat agent's tools reach this
    // app's own API and nothing else — an image would be the only way out.
    image: () => '',
    // marked flags text inside <pre>, <code>, <kbd> and <script> as already
    // escaped, and its tag regex is narrower than HTML5, so whatever it fails
    // to recognize as a tag arrives here as live markup.
    text(token) {
      return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : escapeHtml(token.text);
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
  },
});

export function renderChatMarkdown(input: string): string {
  return chatMarkdown.parse(input, { async: false });
}
