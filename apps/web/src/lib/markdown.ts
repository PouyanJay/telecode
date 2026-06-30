import { Marked, type Tokens } from 'marked';
import type { Highlighter } from 'shiki';

import { MARKDOWN_THEME } from './shiki';

/**
 * Render an agent/user message from markdown to HTML — headings, emphasis, lists, links, tables, blockquotes,
 * and fenced code. Fenced code is highlighted with Shiki (themed to the design tokens) once the highlighter
 * has loaded; until then (or for an unknown language) it renders as plain escaped code, so prose never waits
 * on the highlighter. Pure and synchronous — the HTML is sanitized at the trust boundary by the caller
 * (MessageBody) before it is injected. GFM is on; a single newline is NOT a hard break (standard markdown).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(text: string, highlighter: Highlighter | null): string {
  const parser = new Marked({ gfm: true, breaks: false });
  parser.use({
    renderer: {
      code(token: Tokens.Code): string {
        const lang = (token.lang ?? '').trim().toLowerCase();
        if (highlighter && lang && highlighter.getLoadedLanguages().includes(lang)) {
          return highlighter.codeToHtml(token.text, { lang, theme: MARKDOWN_THEME });
        }
        return `<pre class="md-code"><code>${escapeHtml(token.text)}</code></pre>`;
      },
    },
  });
  // `async: false` narrows the return to string (no async extensions are used), avoiding a cast.
  return parser.parse(text, { async: false });
}
