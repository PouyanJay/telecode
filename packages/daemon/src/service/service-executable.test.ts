import { describe, expect, it } from 'vitest';

import { describeExecutableStability } from './service-executable';

/**
 * The background service bakes the current executable path into the plist/unit, so an ephemeral
 * `npx`/`dlx` cache path would break the service once the cache is cleared. These tests pin the
 * detection that warns a user to install globally before enabling the service.
 */
describe('describeExecutableStability', () => {
  it('treats a global npm install path as stable', () => {
    const result = describeExecutableStability(
      '/usr/local/lib/node_modules/@telecode/cli/bin/telecode.mjs',
    );
    expect(result.stable).toBe(true);
    expect(result.hint).toBeNull();
  });

  it('treats a homebrew global path as stable with no hint', () => {
    const result = describeExecutableStability(
      '/opt/homebrew/lib/node_modules/@telecode/cli/bin/telecode.mjs',
    );
    expect(result.stable).toBe(true);
    expect(result.hint).toBeNull();
  });

  it('flags an npm npx cache path as unstable with a global-install hint', () => {
    const result = describeExecutableStability(
      '/Users/u/.npm/_npx/a1b2c3/node_modules/@telecode/cli/bin/telecode.mjs',
    );
    expect(result.stable).toBe(false);
    expect(result.hint).toMatch(/-g|global/i);
  });

  it('flags a pnpm dlx cache path as unstable with a global-install hint', () => {
    const result = describeExecutableStability(
      '/tmp/dlx-4a2f/node_modules/@telecode/cli/bin/telecode.mjs',
    );
    expect(result.stable).toBe(false);
    expect(result.hint).toMatch(/-g|global/i);
  });
});
