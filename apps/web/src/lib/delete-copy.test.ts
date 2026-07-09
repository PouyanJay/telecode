import { describe, expect, it } from 'vitest';

import { sessionDeleteBody } from './delete-copy';

/**
 * One consequence sentence, three surfaces (board / session view / archived) — the copy must agree
 * everywhere, and each honest specific must only appear when its fact is known.
 */
describe('sessionDeleteBody', () => {
  it('states the base consequences with the machine-untouched reassurance', () => {
    const body = sessionDeleteBody();
    expect(body).toContain('permanently removes the session');
    expect(body).toContain('on every device and browser');
    expect(body).toContain('Files and code on your machine are not touched.');
  });

  it('names the device whose files stay untouched when known', () => {
    expect(sessionDeleteBody({ deviceName: 'studio-mbp' })).toContain(
      'Files and code on studio-mbp are not touched.',
    );
  });

  it('leads with the session title for surfaces that show one', () => {
    const body = sessionDeleteBody({ title: 'Fix the pairing bug' });
    expect(body).toContain('“Fix the pairing bug”, its encrypted history');
    expect(body).not.toContain('This permanently removes');
  });

  it('warns that a chained thread only loses its latest segment', () => {
    expect(sessionDeleteBody({ hasSegments: true })).toContain(
      'only this (latest) segment is deleted',
    );
    expect(sessionDeleteBody()).not.toContain('segment');
  });
});
