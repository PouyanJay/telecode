/**
 * The single ceiling for every OPAQUE sealed blob column the relay stores but can never read
 * (`sealed_meta`, `sealed_title`, …). The plaintext schemas cap their fields (title 512, cwd 1024,
 * model 128 chars), so even with AES-GCM + base64 overhead a legitimate blob is well under 8 KiB; the
 * nonce is a 12-byte GCM IV (16 base64 chars). Enforced relay-side (route zod + `storableSealedMeta`)
 * AND by matching DB CHECK constraints (migrations 0008/0009) — one source of truth so the two layers
 * can never drift. A hostile daemon/client can't bloat a row the relay can't inspect.
 */
export const MAX_SEALED_BLOB_CHARS = 8192;
export const MAX_SEALED_BLOB_NONCE_CHARS = 64;
