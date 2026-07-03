import { describe, expect, it } from 'vitest';

import { isFreeFormQuestion } from './free-form-question';

/**
 * The free-form question detector (Journey 4): decides whether an adopted session's end-of-turn message
 * looks like it is asking the user something, so the daemon offers a handover. Heuristic + dismissible, so
 * it favours precision (a trailing `?` or a clear solicitation) while tolerating misses.
 */
describe('isFreeFormQuestion', () => {
  it('detects a message ending in a question mark', () => {
    expect(isFreeFormQuestion('Which database should we use for the app?')).toBe(true);
  });

  it('detects a trailing question mark through closing quotes/emphasis/brackets', () => {
    expect(isFreeFormQuestion('Should I use the "staging" config?')).toBe(true);
    expect(isFreeFormQuestion('Ready to proceed?**')).toBe(true);
    expect(isFreeFormQuestion('(shall we continue?)')).toBe(true);
  });

  it('detects a solicitation phrased without a question mark', () => {
    expect(isFreeFormQuestion('Let me know which approach you prefer and I will continue.')).toBe(
      true,
    );
    expect(isFreeFormQuestion('Please confirm the target environment before I deploy.')).toBe(true);
  });

  it('ignores a statement that does not solicit input', () => {
    expect(isFreeFormQuestion('I have finished the refactor and all tests pass.')).toBe(false);
    expect(isFreeFormQuestion('Done. The build is green.')).toBe(false);
  });

  it('ignores a message whose only question mark is inside a fenced code block', () => {
    expect(
      isFreeFormQuestion('Here is the regex:\n```\n/foo\\?bar/\n```\nApplied it to the parser.'),
    ).toBe(false);
  });

  it('still triggers on a real question that follows a code block', () => {
    expect(
      isFreeFormQuestion('```\nconst x = 1;\n```\nDoes that match what you had in mind?'),
    ).toBe(true);
  });

  it('ignores empty, whitespace, and undefined messages', () => {
    expect(isFreeFormQuestion(undefined)).toBe(false);
    expect(isFreeFormQuestion('')).toBe(false);
    expect(isFreeFormQuestion('   \n  ')).toBe(false);
  });

  it('ignores an absurdly long blob (not a concise question)', () => {
    expect(isFreeFormQuestion(`${'a '.repeat(5000)}?`)).toBe(false);
  });
});
