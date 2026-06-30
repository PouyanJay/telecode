import { type AdoptSettings } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { isAdoptionAllowed } from './is-adoption-allowed';

const settings = (over: Partial<AdoptSettings>): AdoptSettings => ({
  enabled: true,
  denylist: [],
  ...over,
});

describe('isAdoptionAllowed', () => {
  it('allows adoption when enabled with an empty denylist', () => {
    expect(isAdoptionAllowed(settings({}), '/Users/me/repo')).toBe(true);
  });

  it('blocks everything when disabled (regardless of cwd / denylist)', () => {
    expect(isAdoptionAllowed(settings({ enabled: false }), '/Users/me/repo')).toBe(false);
    expect(isAdoptionAllowed(settings({ enabled: false }), undefined)).toBe(false);
  });

  it('blocks a cwd that exactly matches or is nested under a denylist entry', () => {
    const s = settings({ denylist: ['/Users/me/secret'] });
    expect(isAdoptionAllowed(s, '/Users/me/secret')).toBe(false);
    expect(isAdoptionAllowed(s, '/Users/me/secret/sub/deep')).toBe(false);
  });

  it('does NOT block a sibling path that merely shares the denylist prefix', () => {
    const s = settings({ denylist: ['/Users/me/secret'] });
    expect(isAdoptionAllowed(s, '/Users/me/secret-other')).toBe(true);
  });

  it('allows a session with no cwd (nothing to match) when enabled', () => {
    expect(isAdoptionAllowed(settings({ denylist: ['/x'] }), undefined)).toBe(true);
  });
});
