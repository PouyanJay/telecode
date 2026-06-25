import {
  decodeKey,
  encryptWithContentKey,
  decryptWithContentKey,
  generateContentKey,
  openEnvelopePayload,
  wrapContentKey,
  type EncryptedEnvelopeFields,
  type Envelope,
} from '@telecode/protocol';

/**
 * Daemon-side E2E key management (Phase 3). The daemon holds its persistent X25519 private key and one
 * symmetric content key per session. The flow per session:
 *  - `decryptLaunch` opens the box-sealed `session.launch` using the browser's announced ephemeral pubkey;
 *  - `establish` mints the session's content key (idempotent);
 *  - `keyDelivery` box-wraps that key to a browser's pubkey for a `session.key` message;
 *  - `encrypt` / `decrypt` seal/open every other session frame under the content key (secretbox).
 *
 * A daemon with no keypair (or a session whose launch carried no `sender_public_key`) runs in cleartext
 * mode — `isEncrypted` stays false and the daemon sends/receives plaintext, preserving the pre-E2E path.
 * All crypto routes through `@telecode/protocol`; this module only holds keys + chooses the recipient.
 */
export interface SessionCipher {
  /** Whether this daemon has a keypair and can run E2E sessions. */
  readonly capable: boolean;
  /** Whether a content key has been established for `sessionId` (i.e. it is an E2E session). */
  isEncrypted(sessionId: string): boolean;
  /** Open a box-sealed launch payload using the browser pubkey on the envelope. Throws if not capable. */
  decryptLaunch(envelope: Envelope): Promise<unknown>;
  /** Mint + store the session's content key (idempotent). */
  establish(sessionId: string): void;
  /** Box-wrap the session's content key to `browserPublicKey` for a `session.key` message. */
  keyDelivery(sessionId: string, browserPublicKey: string): Promise<EncryptedEnvelopeFields>;
  /** Seal a payload under the session's content key (secretbox). */
  encrypt(sessionId: string, payload: unknown): Promise<EncryptedEnvelopeFields>;
  /** Open an envelope's payload under its session's content key (secretbox). */
  decrypt(envelope: Envelope): Promise<unknown>;
}

export function createSessionCipher(privateKeyBase64?: string): SessionCipher {
  const privateKey = privateKeyBase64 !== undefined ? decodeKey(privateKeyBase64) : undefined;
  // sessionId -> base64 content key. Presence marks an E2E session.
  const contentKeys = new Map<string, string>();

  function requireKey(sessionId: string): string {
    const key = contentKeys.get(sessionId);
    if (key === undefined) throw new Error(`no content key established for session ${sessionId}`);
    return key;
  }

  return {
    capable: privateKey !== undefined,

    isEncrypted(sessionId): boolean {
      return contentKeys.has(sessionId);
    },

    decryptLaunch(envelope): Promise<unknown> {
      if (privateKey === undefined) throw new Error('daemon has no keypair for E2E');
      if (envelope.sender_public_key === undefined) {
        throw new Error('launch is missing sender_public_key');
      }
      return openEnvelopePayload(envelope, decodeKey(envelope.sender_public_key), privateKey);
    },

    establish(sessionId): void {
      if (!contentKeys.has(sessionId)) contentKeys.set(sessionId, generateContentKey());
    },

    keyDelivery(sessionId, browserPublicKey): Promise<EncryptedEnvelopeFields> {
      if (privateKey === undefined) throw new Error('daemon has no keypair for E2E');
      return wrapContentKey(requireKey(sessionId), decodeKey(browserPublicKey), privateKey);
    },

    encrypt(sessionId, payload): Promise<EncryptedEnvelopeFields> {
      return encryptWithContentKey(payload, requireKey(sessionId));
    },

    decrypt(envelope): Promise<unknown> {
      if (envelope.session_id === undefined)
        throw new Error('cannot decrypt a session-less envelope');
      return decryptWithContentKey(envelope, requireKey(envelope.session_id));
    },
  };
}
