import { describe, expect, it } from 'vitest';

import { diffStatForTool, diffStatFromStrings } from './diff-stat';

/**
 * Gate diff stats (mockup §01-4): a rough ±lines for an Edit/Write permission card, computed at gate
 * time so a routine call is decidable from the inbox. A multiset line diff — order-insensitive, cheap,
 * and honest enough for a glance (never claimed to be a minimal patch).
 */
describe('diffStatFromStrings', () => {
  it('counts changed lines, ignoring the unchanged ones', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc\nd';
    expect(diffStatFromStrings(before, after)).toEqual({ added: 2, removed: 1 });
  });

  it('a pure addition removes nothing', () => {
    expect(diffStatFromStrings('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, removed: 0 });
  });

  it('duplicate lines count per occurrence (multiset, not set)', () => {
    expect(diffStatFromStrings('x\nx\nx', 'x')).toEqual({ added: 0, removed: 2 });
  });

  it('empty inputs mean zero lines, not one empty line', () => {
    expect(diffStatFromStrings('', 'a\nb')).toEqual({ added: 2, removed: 0 });
    expect(diffStatFromStrings('a', '')).toEqual({ added: 0, removed: 1 });
    expect(diffStatFromStrings('', '')).toEqual({ added: 0, removed: 0 });
  });
});

describe('diffStatForTool', () => {
  const noFile = async (): Promise<string | null> => null;

  it('Edit: diffs old_string against new_string', async () => {
    const stat = await diffStatForTool(
      'Edit',
      { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' },
      noFile,
    );
    expect(stat).toEqual({ added: 1, removed: 0 });
  });

  it('Write: diffs the current file content against the incoming content', async () => {
    const readFile = async (path: string): Promise<string | null> =>
      path === 'README.md' ? 'old line' : null;
    const stat = await diffStatForTool(
      'Write',
      { file_path: 'README.md', content: 'new line one\nnew line two' },
      readFile,
    );
    expect(stat).toEqual({ added: 2, removed: 1 });
  });

  it('Write to a file that does not exist yet is all additions', async () => {
    const stat = await diffStatForTool('Write', { file_path: 'new.ts', content: 'a\nb' }, noFile);
    expect(stat).toEqual({ added: 2, removed: 0 });
  });

  it('returns undefined for a tool it cannot stat (no wrong badge for a Bash command)', async () => {
    expect(await diffStatForTool('Bash', { command: 'ls' }, noFile)).toBeUndefined();
  });

  it('returns undefined for a malformed Edit input', async () => {
    expect(await diffStatForTool('Edit', { old_string: 42 }, noFile)).toBeUndefined();
  });

  it('returns undefined for a malformed Write input', async () => {
    expect(await diffStatForTool('Write', { content: 'x' }, noFile)).toBeUndefined();
  });

  it('returns undefined when the reader throws (unreadable or too-large target)', async () => {
    const throwing = async (): Promise<string | null> => {
      throw new Error('EACCES');
    };
    expect(
      await diffStatForTool('Write', { file_path: 'x', content: 'y' }, throwing),
    ).toBeUndefined();
  });
});
