import { describe, expect, it } from 'vitest';

import { formatDoctorReport, runDoctor, type DoctorDeps } from './doctor';

/**
 * Phase 4 variant coverage (T16) for `telecode doctor` (T12): a matrix over every failure mode and their
 * combinations, asserting `ok` flips only on a real failure (a warning never sinks it) and the formatted
 * footer pluralizes the failure count correctly.
 */
function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: '22.4.0',
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    relay: { url: 'ws://127.0.0.1:8080/ws' },
    loadCredentials: async () => ({
      deviceToken: 't',
      userId: 'u',
      deviceId: 'dv_1',
      publicKey: 'pk',
      privateKey: 'sk',
    }),
    probeRelay: async () => ({ ok: true }),
    adoptionHooks: async () => ({ installed: true, events: ['PreToolUse'] }),
    ...overrides,
  };
}

const NODE_OLD: Partial<DoctorDeps> = { nodeVersion: '20.0.0' };
const KEY_MISSING: Partial<DoctorDeps> = { env: {} };
const RELAY_DOWN: Partial<DoctorDeps> = { probeRelay: async () => ({ ok: false, error: 'down' }) };
const RELAY_BAD: Partial<DoctorDeps> = { relay: { error: 'bad url' } };
const UNPAIRED: Partial<DoctorDeps> = { loadCredentials: async () => null };

describe('doctor failure-mode matrix (T16)', () => {
  it.each([
    ['all healthy', {}, true, 0],
    ['node too old', NODE_OLD, false, 1],
    ['node unparseable', { nodeVersion: 'not-a-version' }, false, 1],
    ['key missing', KEY_MISSING, false, 1],
    ['relay down', RELAY_DOWN, false, 1],
    ['relay url invalid', RELAY_BAD, false, 1],
    ['node + key', { ...NODE_OLD, ...KEY_MISSING }, false, 2],
    ['node + key + relay', { ...NODE_OLD, ...KEY_MISSING, ...RELAY_DOWN }, false, 3],
  ])('%s → ok=%s with the right failure count', async (_name, overrides, ok, failures) => {
    const report = await runDoctor(deps(overrides));
    expect(report.ok).toBe(ok);
    expect(report.checks.filter((c) => c.status === 'fail')).toHaveLength(failures);
  });

  it('an unpaired but otherwise healthy machine still passes (warn does not fail)', async () => {
    const report = await runDoctor(deps(UNPAIRED));
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'Device pairing')?.status).toBe('warn');
  });

  it('a warning alongside a real failure keeps both — and the run fails', async () => {
    const report = await runDoctor(deps({ ...UNPAIRED, ...KEY_MISSING }));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'Device pairing')?.status).toBe('warn');
  });

  it('pluralizes the footer by failure count', async () => {
    expect(formatDoctorReport(await runDoctor(deps(KEY_MISSING)))).toContain('1 check failed');
    expect(formatDoctorReport(await runDoctor(deps({ ...NODE_OLD, ...KEY_MISSING })))).toContain(
      '2 checks failed',
    );
    expect(formatDoctorReport(await runDoctor(deps()))).toContain('All checks passed');
  });
});
