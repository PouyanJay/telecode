import DOMPurify from 'dompurify';

/**
 * Sanitize rendered-markdown HTML before it is injected into the DOM — defense in depth, since agent output
 * is not trusted to be free of embedded HTML. DOMPurify keeps its defaults (drops `<script>`/`<iframe>`,
 * event handlers, and `javascript:`/`data:` URLs); we additionally allow:
 *  - `style`, because Shiki colors each code token with an inline `style` — the values come from telecode's
 *    own theme (not the agent), and DOMPurify still sanitizes the CSS;
 *  - `target`, for the new-tab links the hook adds.
 * Links are forced to open in a new tab with `rel=noopener noreferrer` so a link in agent output can't reach
 * back into the app (tabnabbing). Browser-only — DOMPurify needs a DOM, and the live transcript renders
 * client-side, so this is only ever called in the browser (SSR shows plain text instead).
 */
export function sanitizeMarkdownHtml(html: string): string {
  // Re-install the single anchor hook each call (clearing any prior copy first) so it can never stack under
  // dev HMR. Doing it here rather than at module load keeps DOMPurify off the SSR path, where it has no DOM.
  DOMPurify.removeHook('afterSanitizeAttributes');
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'style'] });
}
