import { describe, expect, it } from 'vitest';

import { summarizeTool } from './tool-summary';

/**
 * The one-line tool summary (T11) is the collapsed row of a tool log — e.g. `Read · src/a.ts`. Pure, so
 * it is tested directly; the disclosure component stays a thin renderer.
 */
describe('summarizeTool', () => {
  it('surfaces the salient argument per well-known tool', () => {
    expect(summarizeTool('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(summarizeTool('Edit', { file_path: 'src/a.ts', old_string: 'x' })).toBe('src/a.ts');
    expect(summarizeTool('Bash', { command: 'pnpm test' })).toBe('pnpm test');
    expect(summarizeTool('Grep', { pattern: 'verifySignature' })).toBe('verifySignature');
    expect(summarizeTool('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev');
  });

  it('collapses whitespace/newlines so the row stays a single line', () => {
    expect(summarizeTool('Bash', { command: 'git add .\ngit commit -m x' })).toBe(
      'git add . git commit -m x',
    );
  });

  it('falls back to common argument keys for an unknown tool', () => {
    expect(summarizeTool('SomeFutureTool', { file_path: 'a.ts' })).toBe('a.ts');
    expect(summarizeTool('SomeFutureTool', { query: 'svelte runes' })).toBe('svelte runes');
  });

  it('returns an empty string when nothing salient is present', () => {
    expect(summarizeTool('TodoWrite', { todos: [] })).toBe('');
    expect(summarizeTool('Read', {})).toBe('');
    expect(summarizeTool('Read', { file_path: 42 })).toBe('');
  });
});
