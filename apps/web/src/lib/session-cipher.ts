import {
  decodeKey,
  decryptWithContentKey,
  encodeKey,
  encryptWithContentKey,
  generateKeyPair,
  sealEnvelopePayload,
  unwrapContentKey,
  type EncryptedEnvelopeFields,
  type Envelope,
  type KeyPair,
} from '@telecode/protocol';

/**
 * Browser side of the E2E session cipher (Phase 3) — the mirror of the daemon's `session-cipher`. The
 * browser holds an ephemeral X25519 keypair (regenerated per page load; persistence is Phase 4) and the
 * daemon's public key (from the device list). Per session it: seals the `session.launch` (box) to the
 * daemon, unwraps the per-session content key the daemon delivers (`session.key`), encrypts follow-ups /
 * decisions under that key (secretbox), and decrypts the streamed frames. The relay only ever sees
 * ciphertext. All crypto routes through `@telecode/protocol`.
 *
 * `enabled` is false when there is no daemon public key (a device paired before E2E): then the connection
 * stays cleartext and this cipher is a no-op, preserving the pre-E2E path.
 */
export interface BrowserSessionCipher {
  /** Whether E2E is available (the daemon registered a public key at pairing). */
  readonly enabled: boolean;
  /** This browser's ephemeral public key (base64) to announce on launch/subscribe; undefined if disabled. */
  publicKey(): Promise<string | undefined>;
  /** Box-seal a launch payload to the daemon, returning the wire fields + the announced browser pubkey. */
  sealLaunch(payload: unknown): Promise<EncryptedEnvelopeFields & { senderPublicKey: string }>;
  /** Unwrap + store the content key from an inbound `session.key` envelope. */
  receiveKey(envelope: Envelope): Promise<void>;
  /** Whether a content key has been established for `sessionId`. */
  isEncrypted(sessionId: string): boolean;
  /** Seal a payload under the session's content key (secretbox). */
  encrypt(sessionId: string, payload: unknown): Promise<EncryptedEnvelopeFields>;
  /**
   * Decrypt an inbound frame's payload under its session content key, or return null when the frame is not
   * encrypted (empty nonce / non-string payload — e.g. a relay-generated control message), so the caller
   * uses the envelope as-is.
   */
  tryDecrypt(envelope: Envelope): Promise<unknown>;
}

export function createBrowserSessionCipher(
  daemonPublicKey: string | null | undefined,
  keyPairFactory: () => Promise<KeyPair> = generateKeyPair,
): BrowserSessionCipher {
  const daemonKey = daemonPublicKey ? decodeKey(daemonPublicKey) : undefined;
  // sessionId -> base64 content key. Presence marks an E2E session.
  const contentKeys = new Map<string, string>();
  // The ephemeral keypair, generated lazily once and reused for the connection's lifetime.
  let keyPairPromise: Promise<KeyPair> | null = null;
  function keyPair(): Promise<KeyPair> {
    keyPairPromise ??= keyPairFactory();
    return keyPairPromise;
  }

  function requireKey(sessionId: string): string {
    const key = contentKeys.get(sessionId);
    if (key === undefined) throw new Error(`no content key for session ${sessionId}`);
    return key;
  }

  return {
    enabled: daemonKey !== undefined,

    async publicKey(): Promise<string | undefined> {
      if (daemonKey === undefined) return undefined;
      return encodeKey((await keyPair()).publicKey);
    },

    async sealLaunch(payload): Promise<EncryptedEnvelopeFields & { senderPublicKey: string }> {
      if (daemonKey === undefined) throw new Error('no daemon public key for E2E');
      const kp = await keyPair();
      const sealed = await sealEnvelopePayload(payload, daemonKey, kp.privateKey);
      return { ...sealed, senderPublicKey: encodeKey(kp.publicKey) };
    },

    async receiveKey(envelope): Promise<void> {
      if (daemonKey === undefined || envelope.session_id === undefined) return;
      const kp = await keyPair();
      const contentKey = await unwrapContentKey(envelope, daemonKey, kp.privateKey);
      contentKeys.set(envelope.session_id, contentKey);
    },

    isEncrypted(sessionId): boolean {
      return contentKeys.has(sessionId);
    },

    encrypt(sessionId, payload): Promise<EncryptedEnvelopeFields> {
      return encryptWithContentKey(payload, requireKey(sessionId));
    },

    async tryDecrypt(envelope): Promise<unknown> {
      const sessionId = envelope.session_id;
      if (
        sessionId === undefined ||
        envelope.nonce === '' ||
        typeof envelope.payload !== 'string' ||
        !contentKeys.has(sessionId)
      ) {
        return null;
      }
      return decryptWithContentKey(envelope, requireKey(sessionId));
    },
  };
}
