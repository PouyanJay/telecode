import { rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { encodeKey, generateKeyPair } from '@telecode/protocol';
import { pino } from 'pino';

import { runHookBridge } from './adopt/hook-bridge';
import { installHooks } from './adopt/hooks-install';
import { readHooksStatus } from './adopt/hooks-status';
import { uninstallHooks } from './adopt/hooks-uninstall';
import { loadCredentials, saveCredentials, type StoredCredentials } from './credentials';
import { createDaemon, type Daemon } from './daemon';
import { DaemonUnauthorizedError } from './daemon-unauthorized-error';
import { runDoctorCli } from './doctor-cli';
import { detectOs } from './os-info';
import { pairDevice } from './pairing';
import { resolveRelayUrl } from './relay-url';
import { createExecCommandRunner } from './service/exec-command-runner';
import { offerBackgroundService } from './service/offer-background-service';
import { selectServiceManager } from './service/select-service-manager';
import { runServiceCli } from './service/service-cli';
import { acquireSingleInstanceLock } from './single-instance-lock';
import { createGitRepoManager } from './sessions/repo-manager';
import { createSessionStore } from './sessions/session-store';
import { createGitWorktreeManager } from './sessions/worktree-manager';

/**
 * Daemon entry point (`npx @telecode/cli`). On first run it pairs this device (prints a code to enter in the
 * web app), generates an X25519 keypair, and saves credentials to `~/.telecode/credentials.json`. On
 * later runs it loads the saved token and reconnects — no re-pairing.
 */
const log = pino({
  name: 'daemon',
  level: process.env.LOG_LEVEL ?? 'info',
  // Defense in depth: never let a secret or plaintext payload reach a log sink.
  redact: {
    paths: [
      'token',
      '*.token',
      'payload',
      '*.payload',
      'text',
      'prompt',
      'channel_token',
      'device_token',
      'nonce',
      '*.nonce',
      'privateKey',
      '*.privateKey',
      'private_key',
      '*.private_key',
    ],
    censor: '[redacted]',
  },
});

/**
 * Release the single-instance lock on the one `exit` event, and route SIGINT/SIGTERM through
 * `process.exit(0)` so the release runs exactly once regardless of how the daemon stops.
 */
function releaseLockOnExit(release: () => void): void {
  process.once('exit', release);
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));
}

/** Prompt a yes/no question on the terminal, defaulting to yes (an empty answer). */
async function confirmDefaultYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

const cliArgs = process.argv.slice(2);

// `~/.claude/settings.json` holds telecode's hooks. `hookCommand` is what Claude Code runs for each event:
// this very bin (quoted for spaces) + the `hook` subcommand. `process.argv[1]` is `string | undefined` under
// strict indexing; if the bin path can't be determined, the command is left undefined (adoption can't
// auto-install rather than baking a broken `"undefined" hook` command into the user's settings).
const claudeSettingsPath = join(homedir(), '.claude', 'settings.json');
const daemonBinPath = process.argv[1];
const hookCommand = daemonBinPath !== undefined ? `"${daemonBinPath}" hook` : undefined;

// `telecode doctor`: a preflight that reports whether this machine can run an agent (Node version, API
// key, pairing, relay reachability) and exits — it never starts the daemon.
if (cliArgs.includes('doctor')) {
  const exitCode = await runDoctorCli({ argv: cliArgs, env: process.env });
  process.exit(exitCode);
}

// `telecode hook`: the adoption bridge Claude Code spawns for each hook event — pipe the hook JSON on stdin
// → the daemon's Unix socket → the decision on stdout. Fail-closed (a dead daemon yields `{}`). Never
// starts the daemon. Kept dead-simple since Claude runs it once per tool call.
if (cliArgs[0] === 'hook') {
  const code = await runHookBridge({
    socketPath: join(homedir(), '.telecode', 'run', 'hook.sock'),
    input: process.stdin,
    output: process.stdout,
  });
  process.exit(code);
}

// `telecode hooks <install|uninstall|status>`: opt in/out of adopting your own Claude Code sessions by
// (un)installing telecode's hooks in `~/.claude/settings.json` — transparent, idempotent, reversible.
if (cliArgs[0] === 'hooks') {
  const settingsPath = claudeSettingsPath;
  switch (cliArgs[1]) {
    case 'install':
      if (hookCommand === undefined) {
        log.error('telecode: cannot determine this bin path — run via `npx` or an absolute path');
        process.exit(1);
      }
      await installHooks({ settingsPath, command: hookCommand });
      log.info({ settingsPath }, 'telecode: installed Claude Code hooks — adoption enabled');
      break;
    case 'uninstall':
      await uninstallHooks({ settingsPath });
      log.info({ settingsPath }, 'telecode: removed Claude Code hooks — adoption disabled');
      break;
    case 'status':
      log.info(
        { settingsPath, ...(await readHooksStatus({ settingsPath })) },
        'telecode: Claude Code hooks status',
      );
      break;
    default:
      log.error('usage: telecode hooks <install|uninstall|status>');
      process.exit(1);
  }
  process.exit(0);
}

// `telecode service <install|uninstall|status>`: host the daemon as a user-level login service so it
// starts at login, restarts on crash, and survives reboot — no terminal to keep alive. This only manages
// *how the daemon is hosted*; it never starts the daemon inline (the service does that at login).
if (cliArgs[0] === 'service') {
  const exitCode = await runServiceCli({
    argv: cliArgs,
    env: process.env,
    // Disengage cleanly: on a successful `service uninstall` (the user turning telecode off) also remove its
    // Claude Code hooks, so they don't linger firing `telecode hook` on every tool with no daemon to answer.
    // Injected here at the composition root so the service module stays free of the adoption dependency.
    onUninstallHooks: async () => {
      await uninstallHooks({ settingsPath: claudeSettingsPath });
      log.info(
        { settingsPath: claudeSettingsPath },
        'telecode: removed Claude Code hooks — adoption disabled along with the service',
      );
    },
  });
  process.exit(exitCode);
}

// `--relay-url <wss://…/ws>` (or `TELECODE_RELAY_URL`) points the daemon at a self-hosted relay; the
// default is the local relay. Validated as ws/wss so a typo fails fast.
let relayWsUrl: string;
try {
  relayWsUrl = resolveRelayUrl(cliArgs, process.env);
} catch (err) {
  log.error({ err }, 'daemon: invalid relay URL');
  process.exit(1);
}
log.info({ relayUrl: relayWsUrl }, 'daemon: using relay');
// Derive the relay's HTTP base for the pairing endpoints (ws→http, wss→https, strip the /ws path).
const relayHttpUrl = relayWsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');

// Single-instance lock: refuse to start a second daemon (e.g. a manual `telecode` while the background
// service already runs) — two daemons as the same device would fight over sessions. A stale lock from a
// crashed daemon is reclaimed automatically; the lock is released on exit so the survivor can take over.
const pidFilePath = join(homedir(), '.telecode', 'run', 'daemon.pid');
const lock = await acquireSingleInstanceLock({ pidFilePath });
if (!lock.acquired) {
  log.warn(
    { holderPid: lock.holderPid },
    'daemon: another telecode daemon is already running — not starting a second instance',
  );
  process.exit(0);
}
// Release once, on the single `exit` event; a signal simply routes to `exit` via `process.exit(0)`.
releaseLockOnExit(lock.release);

// Pair this device: generate a keypair, run the device-authorization grant (prints a code to approve in
// the web app), and persist the credentials. Extracted so a re-pair (after a revocation) reuses it.
const credentialsPath = join(homedir(), '.telecode', 'credentials.json');
async function pairAndSaveCredentials(): Promise<StoredCredentials> {
  log.info('daemon: pairing this device');
  const keyPair = await generateKeyPair();
  const publicKey = encodeKey(keyPair.publicKey);
  const paired = await pairDevice({
    relayHttpUrl,
    name: hostname(),
    os: detectOs(),
    publicKey,
    logger: log,
  });
  const creds = { ...paired, publicKey, privateKey: encodeKey(keyPair.privateKey) };
  await saveCredentials(creds);
  log.info({ deviceId: creds.deviceId }, 'daemon: paired; credentials saved');
  return creds;
}

let credentials = await loadCredentials();
const wasJustPaired = !credentials;
if (!credentials) credentials = await pairAndSaveCredentials();

// First run only: offer to host the daemon as a background login service, so there is no terminal to keep
// open. On yes it installs the service and hands off by exiting — the service takes over this session (the
// single-instance lock is released on exit and the service reclaims it). `--no-service` / a non-interactive
// stdin skip the prompt with a hint. Baking `--relay-url` captures the relay this run resolved.
if (wasJustPaired) {
  // A status-only probe manager for platform-support + already-installed checks; status ignores binPath,
  // so the placeholder is harmless (the real install resolves + guards `process.argv[1]` in runServiceCli).
  const serviceManager = selectServiceManager(process.platform, {
    home: homedir(),
    runner: createExecCommandRunner(),
    nodePath: process.execPath,
    binPath: daemonBinPath ?? process.execPath,
  });
  await offerBackgroundService({
    isInteractive: Boolean(process.stdin.isTTY),
    noServiceFlag: cliArgs.includes('--no-service'),
    platformSupported: serviceManager !== null,
    isInstalled: async () => (serviceManager ? (await serviceManager.status()).installed : false),
    confirm: confirmDefaultYes,
    // runServiceCli prints the install confirmation (and any ephemeral-npx warning); the offer's notify
    // adds the distinct hand-off line. It resolves + guards its own binPath (`process.argv[1]`).
    install: async () =>
      (await runServiceCli({
        argv: ['service', 'install', '--relay-url', relayWsUrl],
        env: process.env,
      })) === 0,
    handOff: () => process.exit(0),
    notify: (message) => process.stdout.write(`${message}\n`),
  });
}

// Each session runs in its own git worktree (Phase 2): a launch's GitHub repo is cloned on demand
// (Task 8), or a fixed local checkout via `TELECODE_REPO` is used; a launch with neither runs in the
// daemon's own cwd. Clones live under `~/.telecode/repos`, worktrees under `~/.telecode/worktrees` (A-3).
const telecodeHome = join(homedir(), '.telecode');
const reposRoot = process.env.TELECODE_REPOS_ROOT ?? join(telecodeHome, 'repos');
const worktreesRoot = process.env.TELECODE_WORKTREES_ROOT ?? join(telecodeHome, 'worktrees');
const repoManager = createGitRepoManager({ reposRoot, logger: log });
const worktreeManager = createGitWorktreeManager({ worktreesRoot, logger: log });
const defaultRepoPath = process.env.TELECODE_REPO;
// Finished session transcripts live under `~/.telecode/sessions` so they survive a daemon restart and a
// reopened session backfills its real transcript (invariant #7) rather than going blank.
const sessionsRoot = process.env.TELECODE_SESSIONS_ROOT ?? join(telecodeHome, 'sessions');
const sessionStore = createSessionStore({ dir: sessionsRoot, logger: log });
// Adopt externally-started Claude Code sessions: the daemon listens here for the `telecode hook` bridge,
// and — frictionless setup — AUTO-INSTALLS the Claude Code hooks on start when adoption is enabled (no
// manual `telecode hooks install`). Disable entirely with TELECODE_ADOPT=0.
const isAdoptEnabled = process.env.TELECODE_ADOPT !== '0';
const hookSocketPath = join(telecodeHome, 'run', 'hook.sock');
// The per-machine adoption policy (enabled + denylist), managed from the web and applied at runtime (Journey 3).
const adoptConfigPath = join(telecodeHome, 'adopt-config.json');
// Rebuilt on each (re-)launch so a re-pair uses the fresh credentials + token.
function buildDaemon(creds: StoredCredentials): Daemon {
  const rawGateTimeout = process.env.TELECODE_GATE_TIMEOUT_MS;
  const gateTimeoutOverrideMs =
    rawGateTimeout !== undefined && Number.isFinite(Number(rawGateTimeout))
      ? Number(rawGateTimeout)
      : undefined;
  return createDaemon({
    relayUrl: relayWsUrl,
    userId: creds.userId,
    deviceId: creds.deviceId,
    deviceToken: creds.deviceToken,
    // The persisted X25519 keypair: run every session end-to-end encrypted (Phase 3).
    keyPair: { publicKey: creds.publicKey, privateKey: creds.privateKey },
    logger: log,
    worktreeManager,
    repoManager,
    sessionStore,
    // Gate timeout override (ms); unset → the daemon's 30-minute default, <= 0 disables.
    ...(gateTimeoutOverrideMs !== undefined ? { gateTimeoutMs: gateTimeoutOverrideMs } : {}),
    ...(defaultRepoPath ? { defaultRepoPath } : {}),
    ...(isAdoptEnabled
      ? {
          adopt: {
            socketPath: hookSocketPath,
            configPath: adoptConfigPath,
            settingsPath: claudeSettingsPath,
            // Only auto-install when the bin path is known; otherwise adoption listens but installs nothing.
            ...(hookCommand !== undefined ? { hookCommand } : {}),
          },
        }
      : {}),
    // Device revoked while running → re-pair instead of looping forever on the dead token.
    onUnauthorized: () => void repairAndRelaunch(),
  });
}

let activeDaemon: Daemon | null = null;
let isRepairing = false;

// A revoked/invalid device token can never be accepted, so clear it and re-pair (prints a fresh code to
// approve in the web app), then relaunch. Guarded so concurrent 4001s trigger a single re-pair. A pairing
// failure (network hiccup, user cancels) is fatal: exit non-zero so a service manager restarts + retries,
// rather than leaving the guard stuck true and silently wedging every future re-pair.
async function repairAndRelaunch(): Promise<void> {
  if (isRepairing) return;
  isRepairing = true;
  try {
    log.warn('daemon: device token rejected by the relay (revoked?) — re-pairing this machine');
    await activeDaemon?.stop().catch(() => undefined);
    await rm(credentialsPath, { force: true });
    const creds = await pairAndSaveCredentials();
    await launchDaemon(creds);
  } catch (err) {
    log.error({ err }, 'daemon: re-pairing failed');
    process.exit(1);
  } finally {
    isRepairing = false;
  }
}

async function launchDaemon(creds: StoredCredentials): Promise<void> {
  activeDaemon = buildDaemon(creds);
  try {
    await activeDaemon.start();
    log.info({ deviceId: creds.deviceId }, 'daemon: started');
  } catch (err) {
    // A token rejected on the FIRST connect surfaces here; anything else is fatal.
    if (err instanceof DaemonUnauthorizedError) {
      await repairAndRelaunch();
      return;
    }
    log.error({ err }, 'daemon: failed to start');
    process.exit(1);
  }
}

await launchDaemon(credentials);
