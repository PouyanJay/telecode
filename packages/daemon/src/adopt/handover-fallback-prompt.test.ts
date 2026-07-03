import { describe, expect, it } from 'vitest';

import { buildHandoverFallbackPrompt } from './handover-fallback-prompt';

/**
 * The fresh-launch fallback prompt (Journey 4): when a free-form handover cannot resume the adopted
 * conversation, the fresh continuation is seeded with this text so it continues with context instead of cold.
 */
describe('buildHandoverFallbackPrompt', () => {
  it('carries the summary, the question, and the answer', () => {
    const prompt = buildHandoverFallbackPrompt(
      'Scaffolding a new API and choosing storage.',
      'Which database should we use for the app?',
      'Use Postgres.',
    );
    expect(prompt).toContain('Scaffolding a new API and choosing storage.');
    expect(prompt).toContain('Which database should we use for the app?');
    expect(prompt).toContain('Use Postgres.');
  });

  it('omits the summary section when the summary is empty (still orients on question + answer)', () => {
    const prompt = buildHandoverFallbackPrompt('', 'Which region?', 'us-west');
    expect(prompt).not.toContain('Summary of the session so far');
    expect(prompt).toContain('Which region?');
    expect(prompt).toContain('us-west');
  });

  it('trims whitespace in each part', () => {
    const prompt = buildHandoverFallbackPrompt('  ctx  ', '  q?  ', '  a  ');
    expect(prompt).toContain('\nctx\n');
    expect(prompt).toContain('\nq?\n');
    expect(prompt).toContain('\na\n');
  });
});
