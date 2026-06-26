import { describe, expect, it } from 'vitest';

import { highlight, languageFromPath, toHighlightLanguage } from './highlight';

/**
 * The highlighter is a pure, offline, position-scanning lexer (T10) — no Shiki/WASM, so it works in the
 * PWA offline and is unit-tested directly. The load-bearing invariant: tokenizing is LOSSLESS — joining
 * every token's text reconstructs the input byte-for-byte, so nothing is ever dropped or duplicated when
 * the renderer wraps tokens in spans.
 */
describe('highlight', () => {
  function reconstruct(code: string, lang: Parameters<typeof highlight>[1]): string {
    return highlight(code, lang)
      .map((t) => t.text)
      .join('');
  }

  it('is lossless across languages and content', () => {
    const samples = [
      "const x = 'hi'; // a comment\nreturn x + 1;",
      '{ "a": 1, "b": [true, null] }',
      '#!/bin/bash\necho "$HOME" # home',
      'plain text with `weird` ~chars~ 你好',
      '',
    ] as const;
    for (const code of samples) {
      expect(reconstruct(code, 'ts')).toBe(code);
      expect(reconstruct(code, 'json')).toBe(code);
      expect(reconstruct(code, 'bash')).toBe(code);
      expect(reconstruct(code, 'plain')).toBe(code);
    }
  });

  it('classifies the core token kinds of TypeScript', () => {
    const tokens = highlight("const n = 42; // note\nreturn 'ok';", 'ts');
    const typeOf = (text: string) => tokens.find((t) => t.text === text)?.type;
    expect(typeOf('const')).toBe('keyword');
    expect(typeOf('return')).toBe('keyword');
    expect(typeOf('42')).toBe('number');
    expect(typeOf("'ok'")).toBe('string');
    expect(tokens.find((t) => t.type === 'comment')?.text).toBe('// note');
    // A bare identifier is not a keyword — it stays in a plain run (here coalesced as ` n `).
    expect(tokens.some((t) => t.type === 'plain' && t.text.includes('n'))).toBe(true);
    expect(tokens.some((t) => t.type === 'keyword' && t.text === 'n')).toBe(false);
  });

  it('does not classify keyword-looking substrings inside identifiers', () => {
    const tokens = highlight('constant returnValue', 'ts');
    expect(tokens.every((t) => t.type !== 'keyword')).toBe(true);
  });

  it('treats true/false/null as keywords in JSON and quotes as strings', () => {
    const tokens = highlight('{"on": true, "v": null}', 'json');
    expect(tokens.find((t) => t.text === 'true')?.type).toBe('keyword');
    expect(tokens.find((t) => t.text === 'null')?.type).toBe('keyword');
    expect(tokens.find((t) => t.text === '"on"')?.type).toBe('string');
  });

  it('plain language yields a single plain token', () => {
    const tokens = highlight('anything at all', 'plain');
    expect(tokens).toEqual([{ type: 'plain', text: 'anything at all' }]);
  });

  it('coalesces adjacent plain runs into one token', () => {
    // Whitespace and identifiers collapse so the DOM stays lean.
    const tokens = highlight('a   b', 'ts');
    expect(tokens).toEqual([{ type: 'plain', text: 'a   b' }]);
  });
});

describe('language detection', () => {
  it('maps file extensions to a highlight language', () => {
    expect(languageFromPath('src/a.ts')).toBe('ts');
    expect(languageFromPath('a.test.tsx')).toBe('ts');
    expect(languageFromPath('pkg.json')).toBe('json');
    expect(languageFromPath('run.sh')).toBe('bash');
    expect(languageFromPath('notes.txt')).toBe('plain');
    expect(languageFromPath('Makefile')).toBe('plain');
  });

  it('normalizes fenced-code-block language hints', () => {
    expect(toHighlightLanguage('typescript')).toBe('ts');
    expect(toHighlightLanguage('JS')).toBe('js');
    expect(toHighlightLanguage('shell')).toBe('bash');
    expect(toHighlightLanguage(undefined)).toBe('plain');
    expect(toHighlightLanguage('rust')).toBe('plain');
  });
});
