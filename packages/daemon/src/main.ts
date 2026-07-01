import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import { encodeKey, generateKeyPair } from '@telecode/protocol';
import { pino } from 'pino';

import { runHookBridge } from './adopt/hook-bridge';
import { installHooks } from './adopt/hooks-install';
import { readHooksStatus } from './adopt/hooks-status';
import { uninstallHooks } from './adopt/hooks-uninstall';
import { loadCredentials, saveCredentials } from './credentials';
import { createDaemon } from './daemon';
import { runDoctorCli } from './doctor-cli';
import { detectOs } from './os-info';
import { pairDevice } from './pairing';
import { resolveRelayUrl } from './relay-url';
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

const cliArgs = process.argv.slice(2);
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
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  // The command Claude Code will run: this very bin (quoted in case the install path has spaces), plus
  // the `hook` subcommand.
  const command = `"${process.argv[1]}" hook`;
  switch (cliArgs[1]) {
    case 'install':
      await installHooks({ settingsPath, command });
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

let credentials = await loadCredentials();
if (!credentials) {
  log.info('daemon: no credentials found — pairing this device');
  const keyPair = await generateKeyPair();
  const publicKey = encodeKey(keyPair.publicKey);
  const paired = await pairDevice({
    relayHttpUrl,
    name: hostname(),
    os: detectOs(),
    publicKey,
    logger: log,
  });
  credentials = { ...paired, publicKey, privateKey: encodeKey(keyPair.privateKey) };
  await saveCredentials(credentials);
  log.info({ deviceId: credentials.deviceId }, 'daemon: paired; credentials saved');
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
// Adopt externally-started Claude Code sessions: the daemon listens here for the `telecode hook` bridge.
// Listening is harmless until the user opts in with `telecode hooks install` (which is what makes Claude
// Code actually call the bridge). Disable entirely with TELECODE_ADOPT=0.
const isAdoptEnabled = process.env.TELECODE_ADOPT !== '0';
const hookSocketPath = join(telecodeHome, 'run', 'hook.sock');
// The per-machine adoption policy (enabled + denylist), managed from the web and applied at runtime (Journey 3).
const adoptConfigPath = join(telecodeHome, 'adopt-config.json');

const daemon = createDaemon({
  relayUrl: relayWsUrl,
  userId: credentials.userId,
  deviceId: credentials.deviceId,
  deviceToken: credentials.deviceToken,
  // The persisted X25519 keypair: run every session end-to-end encrypted (Phase 3).
  keyPair: { publicKey: credentials.publicKey, privateKey: credentials.privateKey },
  logger: log,
  worktreeManager,
  repoManager,
  sessionStore,
  ...(defaultRepoPath ? { defaultRepoPath } : {}),
  ...(isAdoptEnabled ? { adopt: { socketPath: hookSocketPath, configPath: adoptConfigPath } } : {}),
});

try {
  await daemon.start();
  log.info({ deviceId: credentials.deviceId }, 'daemon: started');
} catch (err) {
  log.error({ err }, 'daemon: failed to start');
  process.exit(1);
}
