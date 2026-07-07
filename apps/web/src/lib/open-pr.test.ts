import { describe, expect, it } from 'vitest';

import { pullRequestUrl } from './open-pr';

/** The PR link (branch-actions T6): compare page with a base, new-PR page without one. */
describe('pullRequestUrl', () => {
  it('builds the compare/quick-pull URL when the base is known', () => {
    expect(pullRequestUrl('acme/app', 'telecode/fix-login-ab12', 'main')).toBe(
      'https://github.com/acme/app/compare/main...telecode/fix-login-ab12?quick_pull=1',
    );
  });

  it('falls back to the new-PR page (default base) when the base is unknowable', () => {
    expect(pullRequestUrl('acme/app', 'feat/continued')).toBe(
      'https://github.com/acme/app/pull/new/feat/continued',
    );
  });

  it('keeps ref slashes but encodes everything else', () => {
    expect(pullRequestUrl('acme/app', 'feat/hash#tag', 'release/1.0')).toBe(
      'https://github.com/acme/app/compare/release/1.0...feat/hash%23tag?quick_pull=1',
    );
  });
});
