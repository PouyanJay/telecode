import type { StoredCredentials } from './credentials';
import type { ServiceStatus } from './service/service-manager';

/**
 * `telecode doctor` (Phase 4 T12): a preflight that tells a new user, in one screen, whether this machine
 * can run an agent — Node is new enough, the Anthropic API key is set, the device is paired, and the relay
 * is reachable. Pure over injected dependencies so every outcome is unit-tested without touching the
 * network or filesystem; the CLI wrapper supplies the real probes and prints {@link formatDoctorReport}.
 */

/** The outcome of a single check. `warn` is advisory (a fresh install isn't paired yet) and never fails the run. */
export type DoctorStatus = 'pass' | 'warn' | 'fail';

/** One diagnostic line: what was checked, how it went, and a human-readable detail. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

/** The full report. `ok` is false iff any check failed (warnings do not sink it). */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

/** Whether telecode's Claude Code hooks are installed, and for which events (the adoption opt-in state). */
export interface HookStatus {
  readonly installed: boolean;
  readonly events: readonly string[];
}

/** Injected dependencies — the CLI binds these to real probes; tests bind deterministic fakes. */
export interface DoctorDeps {
  /** `process.versions.node`, e.g. `"22.4.0"`. */
  readonly nodeVersion: string;
  readonly env: NodeJS.ProcessEnv;
  /** The resolved relay endpoint, or the resolution error (an invalid `--relay-url`/`TELECODE_RELAY_URL`). */
  readonly relay: { readonly url: string } | { readonly error: string };
  readonly loadCredentials: () => Promise<StoredCredentials | null>;
  /** GET the relay health URL; resolves `{ ok }` (plus an `error` detail when unreachable). */
  readonly probeRelay: (healthUrl: string) => Promise<{ ok: boolean; error?: string }>;
  /** Whether telecode's Claude Code hooks are installed (and for which events) — the adoption opt-in. */
  readonly adoptionHooks: () => Promise<HookStatus>;
  /** The background login-service status, or `null` when telecode has no service impl for this platform. */
  readonly serviceStatus: () => Promise<ServiceStatus | null>;
}

/** Node floor: WebCrypto X25519 (the E2E handshake, Phase 4) needs Node 22+. */
const MIN_NODE_MAJOR = 22;

const makeCheck = (name: string, status: DoctorStatus, detail: string): DoctorCheck => ({
  name,
  status,
  detail,
});

function nodeCheck(nodeVersion: string): DoctorCheck {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (Number.isNaN(major)) {
    return makeCheck('Node.js', 'fail', `could not parse Node version "${nodeVersion}"`);
  }
  return major >= MIN_NODE_MAJOR
    ? makeCheck('Node.js', 'pass', `v${nodeVersion} (>= ${MIN_NODE_MAJOR} required)`)
    : makeCheck(
        'Node.js',
        'fail',
        `v${nodeVersion} is too old — Node ${MIN_NODE_MAJOR}+ is required for WebCrypto X25519`,
      );
}

function apiKeyCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const key = env.ANTHROPIC_API_KEY;
  return key && key.trim() !== ''
    ? makeCheck('Anthropic API key', 'pass', 'ANTHROPIC_API_KEY is set')
    : makeCheck(
        'Anthropic API key',
        'fail',
        'ANTHROPIC_API_KEY is not set — agent sessions cannot run without it',
      );
}

async function pairingCheck(loadCredentials: DoctorDeps['loadCredentials']): Promise<DoctorCheck> {
  const credentials = await loadCredentials();
  return credentials
    ? makeCheck('Device pairing', 'pass', `paired as device ${credentials.deviceId}`)
    : makeCheck('Device pairing', 'warn', 'not paired yet — run `telecode` to pair this device');
}

/** Derive the relay's HTTP health URL from its ws/wss URL (ws→http, wss→https, `/ws`→`/healthz`). */
function healthUrlFor(relayUrl: string): string {
  const httpBase = relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  return `${httpBase}/healthz`;
}

async function relayCheck(
  relay: DoctorDeps['relay'],
  probeRelay: DoctorDeps['probeRelay'],
): Promise<DoctorCheck> {
  if ('error' in relay) {
    return makeCheck('Relay reachability', 'fail', `relay URL is invalid — ${relay.error}`);
  }
  const result = await probeRelay(healthUrlFor(relay.url));
  return result.ok
    ? makeCheck('Relay reachability', 'pass', `reachable at ${relay.url}`)
    : makeCheck(
        'Relay reachability',
        'fail',
        `unreachable at ${relay.url}${result.error ? ` (${result.error})` : ''}`,
      );
}

/**
 * Adoption is opt-in and optional, so this check is advisory (never `fail`): it reports whether telecode is
 * set up to adopt the user's own Claude Code sessions — the `TELECODE_ADOPT` master switch and whether the
 * hooks are installed in `~/.claude/settings.json` (Journey 3).
 */
function adoptionCheck(env: NodeJS.ProcessEnv, hooks: HookStatus): DoctorCheck {
  if (env.TELECODE_ADOPT === '0') {
    return makeCheck('Adopted sessions', 'warn', 'off — TELECODE_ADOPT=0 disables adoption');
  }
  if (!hooks.installed) {
    return makeCheck(
      'Adopted sessions',
      'warn',
      'hooks not installed yet — they install automatically when the daemon runs with adoption enabled',
    );
  }
  return makeCheck(
    'Adopted sessions',
    'pass',
    `adopting your own sessions (hooks: ${hooks.events.join(', ')})`,
  );
}

/**
 * Advisory (never `fail`): whether the daemon is hosted as a background login service. A machine without
 * it still works — the user just keeps a terminal open — so a missing or stopped service is a warning,
 * not a failure. `null` means telecode has no service implementation for this platform yet (e.g. Windows).
 */
function serviceCheck(status: ServiceStatus | null): DoctorCheck {
  if (status === null) {
    return makeCheck(
      'Background service',
      'warn',
      'not available on this platform yet — keep telecode running in a terminal',
    );
  }
  if (!status.installed) {
    return makeCheck(
      'Background service',
      'warn',
      'not installed — run `telecode service install` to run telecode in the background',
    );
  }
  if (!status.running) {
    return makeCheck(
      'Background service',
      'warn',
      'installed but not running — start it with `telecode service start`',
    );
  }
  if (!status.enabled) {
    return makeCheck(
      'Background service',
      'warn',
      'running now but not enabled at login — run `telecode service install` to restore auto-start',
    );
  }
  return makeCheck('Background service', 'pass', 'running in the background (starts at login)');
}

/** Run all diagnostics and assemble the report. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    nodeCheck(deps.nodeVersion),
    apiKeyCheck(deps.env),
    await pairingCheck(deps.loadCredentials),
    await relayCheck(deps.relay, deps.probeRelay),
    serviceCheck(await deps.serviceStatus()),
    adoptionCheck(deps.env, await deps.adoptionHooks()),
  ];
  return { checks, ok: checks.every((c) => c.status !== 'fail') };
}

const GLYPH: Record<DoctorStatus, string> = { pass: '✓', warn: '!', fail: '✗' };

/** Render a report as a glyphed, human-readable block for the terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['telecode doctor', ''];
  for (const c of report.checks) lines.push(`  ${GLYPH[c.status]}  ${c.name}: ${c.detail}`);
  lines.push('');
  const failures = report.checks.filter((c) => c.status === 'fail').length;
  const noun = failures === 1 ? 'check' : 'checks';
  lines.push(report.ok ? 'All checks passed.' : `${failures} ${noun} failed — see above.`);
  return lines.join('\n');
}
