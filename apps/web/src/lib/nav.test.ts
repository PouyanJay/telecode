import { describe, expect, it } from 'vitest';

import { isActive } from './nav';

describe('isActive', () => {
  it('marks the Sessions link active on the dashboard and any session detail page', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/sessions/tc_abc', '/')).toBe(true);
  });

  it('does not mark Sessions active on an unrelated route', () => {
    expect(isActive('/devices', '/')).toBe(false);
    expect(isActive('/settings', '/')).toBe(false);
  });

  it('matches a route exactly and as a path prefix, but not a sibling that merely shares a string start', () => {
    expect(isActive('/devices', '/devices')).toBe(true);
    expect(isActive('/devices/dv_1', '/devices')).toBe(true);
    expect(isActive('/devices-archive', '/devices')).toBe(false);
  });
});
