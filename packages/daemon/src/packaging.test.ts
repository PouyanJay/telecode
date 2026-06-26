import { accessSync, constants, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Packaging guards for the `telecode` CLI wiring (Phase 4 T13). These lock the install path that makes
 * `npx telecode` / a one-line installer work: a `bin` that exposes the `telecode` command, a runnable
 * launcher shim, `tsx` as a runtime dependency (the daemon ships as TypeScript, no build step — mirroring
 * the relay), and an end-user installer script. We do not publish here (A5); these just keep the wiring
 * honest so a regression can't silently break the published command.
 */
const read = (relativeToSrc: string): string =>
  readFileSync(fileURLToPath(new URL(relativeToSrc, import.meta.url)), 'utf8');

const pkg = JSON.parse(read('../package.json')) as {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('telecode CLI packaging', () => {
  it('exposes a `telecode` bin pointing at the launcher shim', () => {
    expect(pkg.bin?.telecode).toBe('bin/telecode.mjs');
  });

  it('ships a launcher shim that is a node executable', () => {
    const shim = read('../bin/telecode.mjs');
    expect(shim.startsWith('#!/usr/bin/env node')).toBe(true);
    // It must load the daemon entry point through tsx (TypeScript, no build step).
    expect(shim).toContain('main.ts');
    expect(shim).toContain('tsx');
  });

  it('keeps tsx as a runtime dependency so the published bin can run', () => {
    expect(pkg.dependencies?.tsx).toBeDefined();
    expect(pkg.devDependencies?.tsx).toBeUndefined();
  });

  it('provides an executable end-user installer that checks node and installs telecode', () => {
    const installerUrl = new URL('../../../scripts/install-telecode.sh', import.meta.url);
    const installerPath = fileURLToPath(installerUrl);
    // Present and executable.
    expect(() => accessSync(installerPath, constants.X_OK)).not.toThrow();
    const installer = readFileSync(installerPath, 'utf8');
    expect(installer.startsWith('#!/usr/bin/env')).toBe(true);
    expect(installer).toContain('set -e');
    expect(installer).toContain('telecode');
    // Guards the Node floor that the daemon's WebCrypto needs.
    expect(installer).toContain('22');
  });
});
