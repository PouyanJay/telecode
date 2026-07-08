import { describe, expect, it } from 'vitest';

import { buildTakeoverFallbackPrompt } from './takeover-fallback-prompt';

describe('buildTakeoverFallbackPrompt', () => {
  it('seeds the fresh launch with the summary and the instruction', () => {
    const prompt = buildTakeoverFallbackPrompt(
      'Refactored the parser; tests green.',
      'now do the printer',
    );
    expect(prompt).toContain('continuing a previous session');
    expect(prompt).toContain('Summary of the session so far:');
    expect(prompt).toContain('Refactored the parser; tests green.');
    expect(prompt).toContain("The user's next instruction:");
    expect(prompt).toContain('now do the printer');
  });

  it('omits the summary block when extraction found nothing (never an empty heading)', () => {
    const prompt = buildTakeoverFallbackPrompt('   ', 'carry on');
    expect(prompt).not.toContain('Summary of the session so far:');
    expect(prompt).toContain('carry on');
  });
});
