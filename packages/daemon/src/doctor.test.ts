import { describe, expect, it } from 'vitest';

import { formatDoctorReport, runDoctor, type DoctorDeps } from './doctor';

/**
 * `telecode doctor` (Phase 4 T12) reports whether the machine can run an agent. `runDoctor` is pure over
 * injected dependencies (node version, env, credential loader, relay probe), so every pass/warn/fail path
 * is tested deterministically with no real network or filesystem.
 */
function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: '22.4.0',
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    relay: { url: 'ws://127.0.0.1:8080/ws' },
    loadCredentials: async () => ({
      deviceToken: 't',
      userId: 'u_1',
      deviceId: 'dv_abc',
      publicKey: 'pk',
      privateKey: 'sk',
    }),
    probeRelay: async () => ({ ok: true }),
    adoptionHooks: async () => ({
      installed: true,
      events: ['PreToolUse', 'SessionStart', 'SessionEnd', 'Notification'],
    }),
    ...overrides,
  };
}

const find = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((c) => c.name === name);

describe('runDoctor', () => {
  it('passes every check on a healthy, paired machine', async () => {
    const report = await runDoctor(deps());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails when Node is older than the WebCrypto floor', async () => {
    const report = await runDoctor(deps({ nodeVersion: '20.11.0' }));
    expect(find(report, 'Node.js')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails when the Anthropic API key is missing or blank', async () => {
    expect(find(await runDoctor(deps({ env: {} })), 'Anthropic API key')?.status).toBe('fail');
    expect(
      find(await runDoctor(deps({ env: { ANTHROPIC_API_KEY: '  ' } })), 'Anthropic API key')
        ?.status,
    ).toBe('fail');
  });

  it('warns (does not fail) when the device is not yet paired', async () => {
    const report = await runDoctor(deps({ loadCredentials: async () => null }));
    expect(find(report, 'Device pairing')?.status).toBe('warn');
    // A warning must not sink the overall result — a fresh install can still pass.
    expect(report.ok).toBe(true);
  });

  it('reports adopted-session status (advisory — installed / not-installed / disabled, never fails)', async () => {
    const installed = await runDoctor(deps());
    const ok = find(installed, 'Adopted sessions');
    expect(ok?.status).toBe('pass');
    expect(ok?.detail).toContain('SessionEnd');

    const notInstalled = await runDoctor(
      deps({ adoptionHooks: async () => ({ installed: false, events: [] }) }),
    );
    expect(find(notInstalled, 'Adopted sessions')?.status).toBe('warn');
    expect(find(notInstalled, 'Adopted sessions')?.detail).toContain('telecode hooks install');

    const disabled = await runDoctor(
      deps({ env: { ANTHROPIC_API_KEY: 'sk', TELECODE_ADOPT: '0' } }),
    );
    expect(find(disabled, 'Adopted sessions')?.status).toBe('warn');
    expect(find(disabled, 'Adopted sessions')?.detail).toContain('TELECODE_ADOPT=0');

    // Advisory only — none of these sink the run.
    expect(notInstalled.ok && disabled.ok).toBe(true);
  });

  it('fails when the relay is unreachable, surfacing the probe error', async () => {
    const report = await runDoctor(
      deps({ probeRelay: async () => ({ ok: false, error: 'ECONNREFUSED' }) }),
    );
    const relay = find(report, 'Relay reachability');
    expect(relay?.status).toBe('fail');
    expect(relay?.detail).toContain('ECONNREFUSED');
    expect(report.ok).toBe(false);
  });

  it('fails the relay check on an invalid relay URL without probing', async () => {
    let probed = false;
    const report = await runDoctor(
      deps({
        relay: { error: 'relay URL must be ws:// or wss://' },
        probeRelay: async () => {
          probed = true;
          return { ok: true };
        },
      }),
    );
    expect(find(report, 'Relay reachability')?.status).toBe('fail');
    expect(probed).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('probes the relay health endpoint derived from the ws URL', async () => {
    const seen: string[] = [];
    await runDoctor(
      deps({
        relay: { url: 'wss://relay.example.com/ws' },
        probeRelay: async (url) => {
          seen.push(url);
          return { ok: true };
        },
      }),
    );
    expect(seen).toEqual(['https://relay.example.com/healthz']);
  });
});

describe('formatDoctorReport', () => {
  it('renders one glyphed line per check and a summary footer', async () => {
    const report = await runDoctor(deps({ loadCredentials: async () => null }));
    const text = formatDoctorReport(report);
    expect(text).toContain('Node.js');
    expect(text).toContain('Relay reachability');
    expect(text).toMatch(/[✓]/);
    expect(text).toContain('All checks passed');
  });

  it('signals failure in the footer when a check fails', async () => {
    const report = await runDoctor(deps({ env: {} }));
    expect(formatDoctorReport(report)).toContain('check failed');
  });
});
