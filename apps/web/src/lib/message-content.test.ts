import { describe, expect, it } from 'vitest';

import { parseMessageContent } from './message-content';

/**
 * The message segmenter (T10) splits one agent-message frame into prose, inline code, and fenced code
 * blocks so the renderer can highlight code and style inline spans while leaving prose untouched. Pure and
 * line-based, so a partial/streamed fence still resolves and it is unit-tested without a DOM.
 */
describe('parseMessageContent', () => {
  it('returns nothing for an empty message', () => {
    expect(parseMessageContent('')).toEqual([]);
  });

  it('keeps plain prose as a single text segment', () => {
    const text = 'Reading the router first to reuse its signature helper.';
    expect(parseMessageContent(text)).toEqual([{ kind: 'text', text }]);
  });

  it('splits a fenced code block out of surrounding prose, carrying the language hint', () => {
    const segments = parseMessageContent("Here's the edit:\n```ts\nconst x = 1;\n```\nDone.");
    expect(segments).toEqual([
      { kind: 'text', text: "Here's the edit:" },
      { kind: 'code', code: 'const x = 1;', language: 'ts' },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('splits inline code spans inside prose', () => {
    const segments = parseMessageContent('Register `charge.refunded` in the router.');
    expect(segments).toEqual([
      { kind: 'text', text: 'Register ' },
      { kind: 'inline-code', text: 'charge.refunded' },
      { kind: 'text', text: ' in the router.' },
    ]);
  });

  it('resolves an unclosed (streaming) fence to a code block through end of input', () => {
    const segments = parseMessageContent('```bash\nnpm run build');
    expect(segments).toEqual([{ kind: 'code', code: 'npm run build', language: 'bash' }]);
  });

  it('handles a bare fence with no language', () => {
    const segments = parseMessageContent('```\nraw\n```');
    expect(segments).toEqual([{ kind: 'code', code: 'raw', language: '' }]);
  });

  it('preserves multi-line code content verbatim', () => {
    const segments = parseMessageContent('```js\na()\n\nb()\n```');
    expect(segments).toEqual([{ kind: 'code', code: 'a()\n\nb()', language: 'js' }]);
  });
});
