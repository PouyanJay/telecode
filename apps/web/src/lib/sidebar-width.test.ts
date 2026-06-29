import { describe, expect, it } from 'vitest';

import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  readSidebarWidth,
  writeSidebarWidth,
} from './sidebar-width';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe('clampSidebarWidth', () => {
  it('keeps an in-range width, rounded to a whole pixel', () => {
    expect(clampSidebarWidth(287.6)).toBe(288);
  });

  it('clamps below the minimum and above the maximum', () => {
    expect(clampSidebarWidth(50)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('falls back to the default for a non-finite width', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe('sidebar-width persistence', () => {
  it('round-trips a written width', () => {
    const storage = memoryStorage();
    writeSidebarWidth(storage, 300);
    expect(readSidebarWidth(storage)).toBe(300);
  });

  it('clamps an out-of-range value on the way in', () => {
    const storage = memoryStorage();
    writeSidebarWidth(storage, 9999);
    expect(readSidebarWidth(storage)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('falls back to the default when unset or corrupt', () => {
    expect(readSidebarWidth(memoryStorage())).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(readSidebarWidth({ getItem: () => 'garbage' })).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
