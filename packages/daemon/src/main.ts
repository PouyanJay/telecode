import { pino } from 'pino';

import { createDaemon } from './daemon';

/**
 * Dev entry point for the daemon (`pnpm --filter @telecode/daemon dev`). Phase 0 uses stub
 * identities; Task 5 (device-authorization grant) replaces these with a real device token.
 */
const log = pino({ name: 'daemon', level: process.env.LOG_LEVEL ?? 'info' });

const daemon = createDaemon({
  relayUrl: process.env.TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws',
  userId: process.env.TELECODE_USER_ID ?? 'u_dev',
  deviceId: process.env.TELECODE_DEVICE_ID ?? 'd_dev',
  logger: log,
});

try {
  await daemon.start();
  log.info('daemon: started');
} catch (err) {
  log.error({ err }, 'daemon: failed to start');
  process.exit(1);
}
