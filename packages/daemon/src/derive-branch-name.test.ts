import { describe, expect, it } from 'vitest';

import { deriveBranchName } from './derive-branch-name';

const SESSION = '8f2a0c1e-aaaa-bbbb-cccc-121212121212';

describe('deriveBranchName', () => {
  it('slugs the prompt and appends the short session id', () => {
    expect(deriveBranchName('Fix the pairing race!', SESSION)).toBe(
      'telecode/fix-the-pairing-race-8f2a0c1e',
    );
  });

  it('collapses runs of non-alphanumerics and never emits leading/trailing dashes', () => {
    expect(deriveBranchName('  ..fix // the -- race?!  ', SESSION)).toBe(
      'telecode/fix-the-race-8f2a0c1e',
    );
  });

  it('caps the slug and never ends the capped slug on a dash', () => {
    const name = deriveBranchName('a'.repeat(23) + ' next words beyond the cap', SESSION);
    expect(name).toBe(`telecode/${'a'.repeat(23)}-8f2a0c1e`);
    expect(name.length).toBeLessThanOrEqual('telecode/'.length + 24 + 1 + 8);
  });

  it('degrades to the plain short-id form when the prompt has no usable characters', () => {
    expect(deriveBranchName('???!!!', SESSION)).toBe('telecode/8f2a0c1e');
    expect(deriveBranchName('', SESSION)).toBe('telecode/8f2a0c1e');
  });
});
