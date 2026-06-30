import { describe, expect, it } from 'vitest';

import { questionsFromToolInput } from './question-from-tool-input';

/**
 * Defensive mapping of the Claude Code `AskUserQuestion` tool input into telecode wire questions. The input
 * is untrusted/version-dependent, so a shape that doesn't fit must fail closed (undefined → the caller
 * defers to the local picker), never a half-formed question.
 */
describe('questionsFromToolInput', () => {
  it('maps the captured AskUserQuestion shape into wire questions', () => {
    const questions = questionsFromToolInput({
      questions: [
        {
          question: 'Which database should we use?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relational.' },
            { label: 'SQLite', description: 'Embedded.' },
          ],
        },
      ],
    });
    expect(questions).toHaveLength(1);
    expect(questions?.[0]?.header).toBe('Database');
    expect(questions?.[0]?.options.map((o) => o.label)).toEqual(['Postgres', 'SQLite']);
  });

  it('defaults a missing multiSelect to false (version-drift tolerance)', () => {
    const questions = questionsFromToolInput({
      questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }] }],
    });
    expect(questions?.[0]?.multiSelect).toBe(false);
  });

  it('returns undefined for input with no questions, empty options, or wrong shape', () => {
    expect(questionsFromToolInput(undefined)).toBeUndefined();
    expect(questionsFromToolInput({})).toBeUndefined();
    expect(questionsFromToolInput({ not_questions: true })).toBeUndefined();
    expect(questionsFromToolInput({ questions: [] })).toBeUndefined();
    expect(
      questionsFromToolInput({ questions: [{ question: 'q', header: 'h', options: [] }] }),
    ).toBeUndefined();
  });
});
