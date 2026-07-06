/**
 * The ceiling for every OPAQUE sealed blob column the relay stores but can never read (`sealed_meta`,
 * `sealed_title`, …). Re-exported from `@telecode/protocol` so the relay's route zod, its DB CHECK
 * constraints (migrations 0008/0009), and the web's BFF re-validation all derive from ONE source and can
 * never drift.
 */
export { MAX_SEALED_BLOB_CHARS, MAX_SEALED_BLOB_NONCE_CHARS } from '@telecode/protocol';
