import { hostname } from 'node:os';

import { encodeKey, generateKeyPair } from '@telecode/protocol';
import { pino } from 'pino';

import { loadCredentials, saveCredentials } from './credentials';
import { createDaemon } from './daemon';
import { pairDevice } from './pairing';

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

const daemon = createDaemon({
  relayUrl: relayWsUrl,
  userId: credentials.userId,
  deviceId: credentials.deviceId,
  deviceToken: credentials.deviceToken,
  logger: log,
});

try {
  await daemon.start();
  log.info({ deviceId: credentials.deviceId }, 'daemon: started');
} catch (err) {
  log.error({ err }, 'daemon: failed to start');
  process.exit(1);
}
