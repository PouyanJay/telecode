import { ProtocolError } from './errors';

/**
 * Shared helpers for the encrypted slice of the wire envelope: the `{ payload, nonce }` shape every E2E
 * frame uses (base64 ciphertext + base64 nonce), plus the narrowing/parse guards every decrypt path runs.
 * The actual seal/open lives in `webcrypto.ts` (AES-GCM); these are the format-level contracts it shares
 * with the cipher seams — so the relay, which forwards frames verbatim, only ever observes ciphertext.
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

/** JSON-parse a decrypted plaintext, surfacing a non-JSON body as a {@link ProtocolError} (not a raw SyntaxError). */
export function parsePlaintext(plaintext: string): unknown {
  try {
    return JSON.parse(plaintext) as unknown;
  } catch (err) {
    throw new ProtocolError('decrypted payload is not valid JSON', { cause: err });
  }
}
