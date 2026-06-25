import { open, seal } from './crypto';

/**
 * Bridge the crypto primitives ({@link seal}/{@link open}) to the wire envelope's `{ payload, nonce }`
 * fields: the sealed ciphertext travels as the envelope `payload` (a base64 string) and the box nonce as
 * the envelope `nonce`. This is the single chokepoint every peer uses to put a payload on the wire under
 * E2E — feature code stays plaintext-facing; only the transport seam seals/opens, so the relay (which
 * forwards the frame verbatim) only ever observes ciphertext.
 */

/** The encrypted slice of an envelope: base64 ciphertext in `payload`, base64 nonce alongside it. */
export interface EncryptedEnvelopeFields {
  readonly payload: string;
  readonly nonce: string;
}

/** Seal a JSON-serializable payload for `recipient`, returning the envelope's `{ payload, nonce }`. */
export async function sealEnvelopePayload(
  payload: unknown,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): Promise<EncryptedEnvelopeFields> {
  const sealed = await seal(JSON.stringify(payload), recipientPublicKey, senderPrivateKey);
  return { payload: sealed.ciphertext, nonce: sealed.nonce };
}

/**
 * Open the encrypted `payload`/`nonce` of a received envelope and JSON-parse it back to its value.
 * Throws if the payload is not a ciphertext string, or if authentication/decryption fails (wrong key or
 * tampered ciphertext — NaCl authenticates before decrypting).
 */
export async function openEnvelopePayload(
  envelope: { readonly payload?: unknown; readonly nonce: string },
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<unknown> {
  if (typeof envelope.payload !== 'string') {
    throw new Error('encrypted envelope payload must be a base64 ciphertext string');
  }
  const plaintext = await open(
    { ciphertext: envelope.payload, nonce: envelope.nonce },
    senderPublicKey,
    recipientPrivateKey,
  );
  return JSON.parse(plaintext) as unknown;
}
