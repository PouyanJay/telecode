import { describe, expect, it } from 'vitest';

import { resolveAdoptSetupState } from './adopt-setup-state';

describe('resolveAdoptSetupState', () => {
  it('is active when enabled and the hooks are installed', () => {
    expect(
      resolveAdoptSetupState({
        enabled: true,
        denylist: [],
        hooksInstalled: true,
        events: ['Stop'],
      }),
    ).toBe('active');
  });

  it('needs attention when enabled but the hooks failed to install', () => {
    expect(
      resolveAdoptSetupState({ enabled: true, denylist: [], hooksInstalled: false, events: [] }),
    ).toBe('attention');
  });

  it('is off when adoption is disabled, regardless of hook state', () => {
    expect(
      resolveAdoptSetupState({
        enabled: false,
        denylist: [],
        hooksInstalled: true,
        events: ['Stop'],
      }),
    ).toBe('off');
    expect(
      resolveAdoptSetupState({ enabled: false, denylist: [], hooksInstalled: false, events: [] }),
    ).toBe('off');
  });
});
