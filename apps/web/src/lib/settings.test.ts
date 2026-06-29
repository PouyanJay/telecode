import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  readPermissionMode,
  writePermissionMode,
} from './settings';

/** A key-honouring in-memory Storage, so read and write must agree on the key to round-trip. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe('permission-mode persistence', () => {
  it('round-trips a written mode (read and write use the same key)', () => {
    const storage = memoryStorage();
    writePermissionMode(storage, 'acceptEdits');
    expect(readPermissionMode(storage)).toBe('acceptEdits');
  });

  it('falls back to the conservative default when unset', () => {
    expect(readPermissionMode(memoryStorage())).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('falls back to the default for a corrupt/unknown stored value', () => {
    const corrupt: Pick<Storage, 'getItem'> = { getItem: () => 'garbage' };
    expect(readPermissionMode(corrupt)).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('offers exactly the three surfaced modes and omits the gate-bypassing one', () => {
    const values = PERMISSION_MODES.map((mode) => mode.value);
    expect(values).toEqual(['plan', 'default', 'acceptEdits']);
    expect(values).not.toContain('bypassPermissions');
  });
});
