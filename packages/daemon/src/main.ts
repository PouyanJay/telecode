import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import { encodeKey, generateKeyPair } from '@telecode/protocol';
import { pino } from 'pino';

import { loadCredentials, saveCredentials } from './credentials';
import { createDaemon } from './daemon';
import { pairDevice } from './pairing';
import { createGitRepoManager } from './sessions/repo-manager';
import { createGitWorktreeManager } from './sessions/worktree-manager';

/**
 * Daemon entry point (`npx telecode`). On first run it pairs this device (prints a code to enter in the
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
    ],
    censor: '[redacted]',
  },
});
const relayWsUrl = process.env.TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
// Derive the relay's HTTP base for the pairing endpoints (ws→http, wss→https, strip the /ws path).
const relayHttpUrl = relayWsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');

let credentials = await loadCredentials();
if (!credentials) {
  log.info('daemon: no credentials found — pairing this device');
  const keyPair = await generateKeyPair();
  const publicKey = encodeKey(keyPair.publicKey);
  const paired = await pairDevice({ relayHttpUrl, name: hostname(), publicKey, logger: log });
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
  ...(defaultRepoPath ? { defaultRepoPath } : {}),
});

try {
  await daemon.start();
  log.info({ deviceId: credentials.deviceId }, 'daemon: started');
} catch (err) {
  log.error({ err }, 'daemon: failed to start');
  process.exit(1);
}
