import { describe, expect, it } from 'vitest';

import { deriveSessionTitle, resolveLaunchTitle } from './derive-title';

describe('deriveSessionTitle', () => {
  it('derives no title from an empty or whitespace-only prompt (wire allows " ")', () => {
    expect(deriveSessionTitle('')).toBeUndefined();
    expect(deriveSessionTitle('   \n\t  \n  ')).toBeUndefined();
  });

  it('takes the first non-empty line and collapses its whitespace', () => {
    expect(deriveSessionTitle('\n\n  Fix   the\tlogin bug  \nand more')).toBe('Fix the login bug');
  });

  it('keeps an exactly-80-char line untouched and truncates 81 with an ellipsis', () => {
    const exact = 'a'.repeat(80);
    expect(deriveSessionTitle(exact)).toBe(exact);

    const over = 'a'.repeat(81);
    const truncated = deriveSessionTitle(over);
    expect(truncated).toBe(`${'a'.repeat(79)}…`);
    expect(truncated).toHaveLength(80);
  });

  it('never leaves trailing whitespace before the ellipsis', () => {
    const spaceAtCut = `${'a'.repeat(78)} bbbbb`;
    expect(deriveSessionTitle(spaceAtCut)).toBe(`${'a'.repeat(78)}…`);
  });
});

describe('resolveLaunchTitle', () => {
  it('prefers the user-typed title verbatim and marks it user-sourced', () => {
    expect(resolveLaunchTitle('My run', 'ignored prompt')).toEqual({
      title: 'My run',
      titleSource: 'user',
    });
  });

  it('derives from the prompt when the user typed none', () => {
    expect(resolveLaunchTitle(undefined, 'Do the thing\nlater')).toEqual({
      title: 'Do the thing',
      titleSource: 'derived',
    });
  });

  it('yields nothing for a whitespace-only prompt and no user title', () => {
    expect(resolveLaunchTitle(undefined, ' \n ')).toBeUndefined();
  });
});
