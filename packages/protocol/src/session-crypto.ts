import { decodeKey, encodeKey, generateSecretKey, openSecret, sealSecret } from './crypto';
import {
  openEnvelopePayload,
  parsePlaintext,
  requireCiphertext,
  sealEnvelopePayload,
  type EncryptedEnvelopeFields,
} from './envelope-crypto';
import { ProtocolError } from './errors';
import { sessionKeyPayloadSchema } from './session';

/**
 * The per-session content-key flow (plan §3.6, Phase 3 Q1). The relay broadcasts one identical frame to
 * every browser on a channel, so daemon→web payloads can't be sealed pairwise to a single browser. Instead
 * the daemon mints one symmetric **content key** per session and encrypts each payload ONCE under it
 * ({@link encryptWithContentKey}); the single broadcast frame then decrypts for every subscriber. The key
 * itself is distributed by wrapping it (authenticated `box`) to each browser's ephemeral public key
 * ({@link wrapContentKey}) — only that browser can {@link unwrapContentKey} it. All crypto routes through
 * `@telecode/protocol`; the relay only ever forwards ciphertext.
 */

/** Mint a fresh per-session content key, base64-encoded for transport + in-memory keying. */
export function generateContentKey(): string {
  return encodeKey(generateSecretKey());
}

/**
 * Wrap a content key for one recipient browser: box-seal `{ key }` to its ephemeral public key. Returns
 * the envelope's `{ payload, nonce }` fields for a `session.key` message. Call once per subscriber.
 */
export function wrapContentKey(
  contentKey: string,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): Promise<EncryptedEnvelopeFields> {
  return sealEnvelopePayload({ key: contentKey }, recipientPublicKey, senderPrivateKey);
}

/**
 * Unwrap a content key from a received `session.key` envelope (box). Validates the decrypted shape and
 * returns the base64 content key. Throws if authentication fails (wrong recipient / tampered) or the
 * payload isn't a valid key envelope.
 */
export async function unwrapContentKey(
  envelope: { readonly payload?: unknown; readonly nonce: string },
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<string> {
  const opened = await openEnvelopePayload(envelope, senderPublicKey, recipientPrivateKey);
  return sessionKeyPayloadSchema.parse(opened).key;
}

/** Encrypt a JSON-serializable payload once under the content key (secretbox), for the wire envelope. */
export async function encryptWithContentKey(
  payload: unknown,
  contentKey: string,
): Promise<EncryptedEnvelopeFields> {
  const sealed = await sealSecret(JSON.stringify(payload), decodeKey(contentKey));
  return { payload: sealed.ciphertext, nonce: sealed.nonce };
}

/**
 * Decrypt a received envelope's `payload`/`nonce` under the content key (secretbox) and JSON-parse it.
 * Throws if the payload isn't a ciphertext string or authentication/decryption fails.
 */
export async function decryptWithContentKey(
  envelope: { readonly payload?: unknown; readonly nonce: string },
  contentKey: string,
): Promise<unknown> {
  const ciphertext = requireCiphertext(envelope);
  let plaintext: string;
  try {
    plaintext = await openSecret({ ciphertext, nonce: envelope.nonce }, decodeKey(contentKey));
  } catch (err) {
    throw new ProtocolError('failed to decrypt payload under the session content key', {
      cause: err,
    });
  }
  return parsePlaintext(plaintext);
}
