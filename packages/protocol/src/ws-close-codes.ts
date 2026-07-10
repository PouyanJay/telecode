/**
 * WebSocket close codes that carry meaning across the wire — the relay closes with them and the daemon
 * reacts to them, so they belong in the shared protocol (invariant #6: one wire contract). Application
 * close codes live in the 4000–4999 range.
 */

/** The relay rejected a peer's `hello` as unauthorized — an invalid or revoked device/channel token. */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/**
 * The relay could not complete the `hello` because a dependency (the database) was transiently
 * unavailable — NOT an auth failure. The peer should reconnect and retry with its EXISTING credentials
 * (never re-pair). Distinguishes a cold/paused DB from a genuinely invalid token, so a DB hiccup can't
 * knock a valid device offline. The daemon treats any non-4001 close as a plain reconnect, so this rides
 * that path; the distinct code is for honest logging and the wire contract.
 */
export const WS_CLOSE_TRY_AGAIN = 4002;
