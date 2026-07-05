/**
 * WebSocket close codes that carry meaning across the wire — the relay closes with them and the daemon
 * reacts to them, so they belong in the shared protocol (invariant #6: one wire contract). Application
 * close codes live in the 4000–4999 range.
 */

/** The relay rejected a peer's `hello` as unauthorized — an invalid or revoked device/channel token. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
