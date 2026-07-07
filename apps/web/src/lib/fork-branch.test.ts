import { describe, expect, it } from 'vitest';

import { forkBaseOptions } from './fork-branch';

/** The fork picker's base list (branch-actions T5): parent first (the default), listing after. */
describe('forkBaseOptions', () => {
  const listing = { available: true, branches: ['main', 'develop', 'telecode/parent-ab12'] };

  it('puts the parent branch first and dedupes it out of the listing', () => {
    expect(forkBaseOptions('telecode/parent-ab12', listing)).toEqual([
      'telecode/parent-ab12',
      'main',
      'develop',
    ]);
  });

  it('offers just the listing when the parent branch is unknown', () => {
    expect(forkBaseOptions(undefined, listing)).toEqual([
      'main',
      'develop',
      'telecode/parent-ab12',
    ]);
  });

  it('offers just the parent when the listing is absent or unavailable', () => {
    expect(forkBaseOptions('feat/x', undefined)).toEqual(['feat/x']);
    expect(forkBaseOptions('feat/x', { available: false, branches: [] })).toEqual(['feat/x']);
    expect(forkBaseOptions(undefined, undefined)).toEqual([]);
  });
});
