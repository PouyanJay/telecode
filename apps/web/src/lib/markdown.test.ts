import type { Highlighter } from 'shiki';
import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown';

/** Render without a Shiki highlighter (the unit boundary): prose is full markdown, code is plain-escaped. */
const md = (text: string): string => renderMarkdown(text, null);

/** A no-WASM stub highlighter that knows only `ts`, so the delegate-vs-fallback branch can be unit-tested. */
const stubHighlighter = {
  getLoadedLanguages: () => ['ts'],
  codeToHtml: () => '<pre class="shiki">STUB</pre>',
} as unknown as Highlighter;

describe('renderMarkdown', () => {
  it('renders headings instead of leaving raw ## markers', () => {
    const html = md('## Summary');
    expect(html).toContain('<h2>Summary</h2>');
    expect(html).not.toContain('## Summary');
  });

  it('renders an empty message to empty/whitespace HTML without throwing', () => {
    expect(md('')).toBe('');
  });

  it('renders bold and italic instead of raw ** / _ markers', () => {
    expect(md('**Model Name:**')).toContain('<strong>Model Name:</strong>');
    expect(md('_keyless_')).toContain('<em>keyless</em>');
  });

  it('renders unordered lists', () => {
    const html = md('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders ordered lists', () => {
    const html = md('1. first\n2. second');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>first</li>');
  });

  it('renders blockquotes', () => {
    expect(md('> quoted')).toContain('<blockquote>');
  });

  it('renders inline code as a <code> element', () => {
    expect(md('use `qwen2.5-3b-instruct` here')).toContain('<code>qwen2.5-3b-instruct</code>');
  });

  it('renders links (the href; target/rel are added later at sanitize time)', () => {
    const html = md('[docs](https://telecode.io/docs)');
    expect(html).toContain('href="https://telecode.io/docs"');
    expect(html).toContain('>docs</a>');
  });

  it('renders GFM tables', () => {
    const html = md('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders a fenced code block as escaped plain code when no highlighter is available', () => {
    const html = md('```ts\nconst x = 1 < 2;\n```');
    expect(html).toContain('<pre class="md-code">');
    // The code is HTML-escaped so `<` can never inject markup.
    expect(html).toContain('const x = 1 &lt; 2;');
  });

  it('delegates a fenced block to the highlighter when its language is loaded', () => {
    const html = renderMarkdown('```ts\nconst x = 1;\n```', stubHighlighter);
    expect(html).toContain('<pre class="shiki">STUB</pre>');
    expect(html).not.toContain('md-code');
  });

  it('falls back to escaped plain code for a language the highlighter has not loaded', () => {
    const html = renderMarkdown('```python\nx = 1\n```', stubHighlighter);
    expect(html).toContain('<pre class="md-code">');
    expect(html).not.toContain('STUB');
  });

  it('does NOT sanitize — raw HTML passes through, so the caller MUST sanitize before injecting', () => {
    // marked has no built-in sanitizer (since v5): raw HTML is emitted verbatim. This documents WHY
    // MessageBody runs the output through DOMPurify (sanitize-html.ts) before any {@html} injection.
    const html = md('a <img src=x onerror="alert(1)"> b');
    expect(html).toContain('<img');
  });
});
