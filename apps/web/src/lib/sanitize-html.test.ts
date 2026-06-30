// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { sanitizeMarkdownHtml } from './sanitize-html';

/**
 * The XSS trust boundary. Every `{@html}` injection in the transcript passes through here, and `marked`
 * emits raw HTML verbatim — so this DOMPurify pass is what actually stops a script/handler/`javascript:`
 * link in agent output, while preserving Shiki's inline color styles and the safe-new-tab links. Runs in
 * jsdom because DOMPurify needs a DOM.
 */
describe('sanitizeMarkdownHtml', () => {
  it('strips <script> tags', () => {
    expect(sanitizeMarkdownHtml('before<script>alert(1)</script>after')).not.toContain('<script');
  });

  it('strips inline event handlers', () => {
    expect(sanitizeMarkdownHtml('<img src="x" onerror="alert(1)" />')).not.toContain('onerror');
  });

  it('strips javascript: hrefs', () => {
    expect(sanitizeMarkdownHtml('<a href="javascript:alert(1)">x</a>')).not.toContain(
      'javascript:',
    );
  });

  it('forces links to open in a new tab with rel=noopener (no tabnabbing)', () => {
    const out = sanitizeMarkdownHtml('<a href="https://telecode.io">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("preserves Shiki's inline color styles on code spans (so highlighting survives sanitizing)", () => {
    expect(sanitizeMarkdownHtml('<span style="color:#c191d6">k</span>')).toContain('style="color:');
  });
});
