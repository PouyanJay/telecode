/**
 * Thrown from {@link import('./daemon').Daemon.start} when the relay rejects this device's token as
 * unauthorized (the device was revoked, or the credentials belong to a different relay/DB). The
 * composition root catches it to clear the stale credentials and re-pair, rather than looping forever on
 * a token that will never be accepted.
 */
export class DaemonUnauthorizedError extends Error {
  constructor() {
    super('relay rejected the device token (unauthorized) — this device needs to be re-paired');
    this.name = 'DaemonUnauthorizedError';
  }
}
