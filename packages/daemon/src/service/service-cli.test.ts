import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner, CommandSpec } from './command-runner';
import { runServiceCli } from './service-cli';

/**
 * Walking skeleton for the background login service: drive the `telecode service` CLI end-to-end
 * through the OS selector → the macOS launchd manager → a REAL temp filesystem, with the OS command
 * boundary faked. `launchctl` is never run in CI — the fake `CommandRunner` records the planned
 * commands so we assert the *exact plan* (bootstrap on install, bootout on uninstall) alongside the
 * on-disk plist artifact. This proves every layer of the feature is wired before any real behavior.
 */
function createFakeRunner(result?: CommandResult): { runner: CommandRunner; calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = {
    run(spec) {
      calls.push(spec);
      return Promise.resolve(result ?? { ok: true, stdout: '', stderr: '', code: 0 });
    },
  };
  return { runner, calls };
}

describe('runServiceCli — macOS launchd walking skeleton', () => {
  const UID = 501;
  const RELAY = 'wss://relay.example.test/ws';
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-svc-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('runs the install → status → uninstall roundtrip, writing the plist and planning launchctl', async () => {
    // Arrange
    const { runner, calls } = createFakeRunner();
    const out: string[] = [];
    const base = {
      env: { TELECODE_RELAY_URL: RELAY } as NodeJS.ProcessEnv,
      platform: 'darwin' as const,
      home,
      runner,
      uid: UID,
      nodePath: '/usr/local/bin/node',
      binPath: '/opt/telecode/bin/telecode.mjs',
      write: (text: string): void => void out.push(text),
    };
    const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.telecode.daemon.plist');

    // Act + Assert — status before install reports not installed
    await runServiceCli({ ...base, argv: ['service', 'status'] });
    expect(out.join('')).toMatch(/installed:\s*no/i);

    // Act + Assert — install writes the plist (with node, bin, and the baked relay URL) and plans bootstrap
    out.length = 0;
    const installCode = await runServiceCli({ ...base, argv: ['service', 'install'] });
    expect(installCode).toBe(0);
    const plist = await readFile(plistPath, 'utf8');
    expect(plist).toContain('ai.telecode.daemon');
    expect(plist).toContain('/usr/local/bin/node');
    expect(plist).toContain('/opt/telecode/bin/telecode.mjs');
    expect(plist).toContain(RELAY);
    const bootstrap = calls.find((c) => c.command === 'launchctl' && c.args[0] === 'bootstrap');
    expect(bootstrap?.args).toEqual(['bootstrap', `gui/${UID}`, plistPath]);

    // Act + Assert — status after install reports installed
    out.length = 0;
    await runServiceCli({ ...base, argv: ['service', 'status'] });
    expect(out.join('')).toMatch(/installed:\s*yes/i);

    // Act + Assert — uninstall removes the plist and plans bootout
    out.length = 0;
    const uninstallCode = await runServiceCli({ ...base, argv: ['service', 'uninstall'] });
    expect(uninstallCode).toBe(0);
    await expect(readFile(plistPath, 'utf8')).rejects.toThrow();
    const bootout = calls.find((c) => c.command === 'launchctl' && c.args[0] === 'bootout');
    expect(bootout?.args).toEqual(['bootout', `gui/${UID}`, plistPath]);
  });

  it('reports a launchctl bootstrap failure as a non-zero exit and a clean message', async () => {
    // Arrange — the fake runner reports launchctl failing (e.g. the agent is already loaded)
    const { runner } = createFakeRunner({
      ok: false,
      stdout: '',
      stderr: 'Bootstrap failed: 5: Input/output error',
      code: 5,
    });
    const out: string[] = [];

    // Act
    const code = await runServiceCli({
      argv: ['service', 'install'],
      env: {},
      platform: 'darwin',
      home,
      runner,
      uid: UID,
      nodePath: '/usr/local/bin/node',
      binPath: '/opt/telecode/bin/telecode.mjs',
      write: (text) => void out.push(text),
    });

    // Assert — the contract holds: a failure is a clean line + exit 1, not a thrown stack trace
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/failed/i);
  });

  it('reports an unsupported platform and leaves the filesystem untouched', async () => {
    // Arrange
    const { runner } = createFakeRunner();
    const out: string[] = [];

    // Act
    const code = await runServiceCli({
      argv: ['service', 'status'],
      env: {},
      platform: 'aix',
      home,
      runner,
      nodePath: '/usr/local/bin/node',
      binPath: '/opt/telecode/bin/telecode.mjs',
      write: (text) => void out.push(text),
    });

    // Assert
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/not.*supported/i);
    expect(await readdir(home)).toHaveLength(0);
  });
});

describe('runServiceCli — start / stop / logs dispatch', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'telecode-svc-logs-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // Built per test with the live temp `home` so the closure never reads a stale binding.
  function makeBase(currentHome: string, write: (text: string) => void) {
    return {
      env: {} as NodeJS.ProcessEnv,
      platform: 'darwin' as const,
      home: currentHome,
      runner: createFakeRunner().runner,
      uid: 501,
      nodePath: '/usr/local/bin/node',
      binPath: '/opt/telecode/bin/telecode.mjs',
      write,
    };
  }

  it('dispatches start once the service is installed', async () => {
    // Arrange — install first so the plist exists
    const out: string[] = [];
    const base = makeBase(home, (t) => void out.push(t));
    await runServiceCli({ ...base, argv: ['service', 'install'] });
    out.length = 0;

    // Act
    const code = await runServiceCli({ ...base, argv: ['service', 'start'] });

    // Assert
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/started/i);
  });

  it('dispatches stop', async () => {
    // Arrange
    const out: string[] = [];

    // Act
    const code = await runServiceCli({
      ...makeBase(home, (t) => void out.push(t)),
      argv: ['service', 'stop'],
    });

    // Assert
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/stopped/i);
  });

  it('prints the recent lines of the service log', async () => {
    // Arrange — a log file at the platform log path
    const logDir = join(home, '.telecode', 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'daemon.log'), 'first line\nsecond line\nthird line\n');
    const out: string[] = [];

    // Act
    const code = await runServiceCli({
      ...makeBase(home, (t) => void out.push(t)),
      argv: ['service', 'logs'],
    });

    // Assert
    expect(code).toBe(0);
    expect(out.join('')).toContain('first line');
    expect(out.join('')).toContain('third line');
  });

  it('reports that there are no logs yet for an absent log file', async () => {
    // Arrange
    const out: string[] = [];

    // Act
    const code = await runServiceCli({
      ...makeBase(home, (t) => void out.push(t)),
      argv: ['service', 'logs'],
    });

    // Assert
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/no logs yet/i);
  });

  it('reports that there are no logs yet for an empty log file', async () => {
    // Arrange — a present-but-empty log file (distinct cause, same message as an absent file)
    const logDir = join(home, '.telecode', 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'daemon.log'), '');
    const out: string[] = [];

    // Act
    const code = await runServiceCli({
      ...makeBase(home, (t) => void out.push(t)),
      argv: ['service', 'logs'],
    });

    // Assert
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/no logs yet/i);
  });
});
