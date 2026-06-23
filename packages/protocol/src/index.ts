/**
 * @telecode/protocol — the single shared wire contract used by the relay, daemon, and web.
 *
 * Phase 0 (Task 1): placeholder export proving the toolchain. Task 2 adds the zod
 * `Envelope`, the message union, and the libsodium crypto helpers.
 */

/** Wire protocol version. Bump on any breaking change to the envelope or message union. */
export const PROTOCOL_VERSION = 1 as const;
