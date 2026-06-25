import { open, seal } from './crypto';
import { ProtocolError } from './errors';

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

/**
 * Narrow a received envelope to its ciphertext string, or throw. Shared by every decrypt path (box and
 * secretbox) so the precondition + error identity stay in one place. `Envelope.payload` is typed
 * `payload?: unknown` (zod `z.unknown()` makes the key optional), and may be a plaintext object in
 * non-E2E mode — both are rejected here before any crypto runs.
 */
export function requireCiphertext(envelope: { readonly payload?: unknown }): string {
  if (typeof envelope.payload !== 'string') {
    throw new ProtocolError('encrypted envelope payload must be a base64 ciphertext string');
  }
  return envelope.payload;
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
 * Throws a {@link ProtocolError} if the payload is not a ciphertext string, if authentication/decryption
 * fails (wrong key or tampered ciphertext — NaCl authenticates before decrypting), or if the decrypted
 * bytes are not valid JSON. The underlying failure is attached via `cause`.
 */
export async function openEnvelopePayload(
  envelope: { readonly payload?: unknown; readonly nonce: string },
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<unknown> {
  const ciphertext = requireCiphertext(envelope);
  let plaintext: string;
  try {
    plaintext = await open(
      { ciphertext, nonce: envelope.nonce },
      senderPublicKey,
      recipientPrivateKey,
    );
  } catch (err) {
    throw new ProtocolError('failed to open sealed envelope payload', { cause: err });
  }
  return parsePlaintext(plaintext);
}

/** JSON-parse a decrypted plaintext, surfacing a non-JSON body as a {@link ProtocolError} (not a raw SyntaxError). */
export function parsePlaintext(plaintext: string): unknown {
  try {
    return JSON.parse(plaintext) as unknown;
  } catch (err) {
    throw new ProtocolError('decrypted payload is not valid JSON', { cause: err });
  }
}
