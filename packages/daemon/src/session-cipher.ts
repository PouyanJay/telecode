import {
  deriveSharedKey,
  exportContentKey,
  generateContentKey,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  openPayload,
  sealPayload,
  type CryptoKeyHandle,
  type EncryptedEnvelopeFields,
  type Envelope,
} from '@telecode/protocol';

/**
 * Daemon-side E2E key management (Phase 3, migrated to WebCrypto in Phase 4). The daemon holds its
 * persistent X25519 identity key and one symmetric content key per session. The flow per session:
 *  - `decryptLaunch` derives the shared key from (daemon private, browser public) and opens the sealed launch;
 *  - `establish` mints the session's content key (AES-256-GCM, idempotent);
 *  - `keyDelivery` wraps that content key to a browser's public key (ECDH→HKDF→AES-GCM) for `session.key`;
 *  - `encrypt` / `decrypt` seal/open every other session frame under the content key (AES-GCM).
 *
 * A daemon with no keypair (or a session whose launch carried no `sender_public_key`) runs in cleartext
 * mode — `isEncrypted` stays false and the daemon sends/receives plaintext, preserving the pre-E2E path.
 * All crypto routes through `@telecode/protocol`; this module only holds keys + chooses the recipient.
 *
 * Key handles are imported lazily and memoised (import is async); the daemon's identity key stays
 * extractable in process memory only — it never re-exports it.
 */
export interface SessionCipher {
  /** Whether this daemon has a keypair and can run E2E sessions. */
  readonly enabled: boolean;
  /** Whether a content key has been established for `sessionId` (i.e. it is an E2E session). */
  isEncrypted(sessionId: string): boolean;
  /** Open a sealed launch payload using the browser pubkey on the envelope. Throws if not capable. */
  decryptLaunch(envelope: Envelope): Promise<unknown>;
  /** Mint + store the session's content key (idempotent). */
  establish(sessionId: string): void;
  /** Wrap the session's content key to `browserPublicKey` for a `session.key` message. */
  keyDelivery(sessionId: string, browserPublicKey: string): Promise<EncryptedEnvelopeFields>;
  /** Seal a payload under the session's content key (AES-GCM). */
  encrypt(sessionId: string, payload: unknown): Promise<EncryptedEnvelopeFields>;
  /** Open an envelope's payload under its session's content key (AES-GCM). */
  decrypt(envelope: Envelope): Promise<unknown>;
}

export function createSessionCipher(privateKeyBase64?: string): SessionCipher {
  // The daemon's X25519 identity private key, imported once on first use.
  let identityPromise: Promise<CryptoKeyHandle> | null = null;
  function identityPrivateKey(): Promise<CryptoKeyHandle> {
    if (privateKeyBase64 === undefined) throw new Error('daemon has no keypair for E2E');
    identityPromise ??= importIdentityPrivateKey(privateKeyBase64);
    return identityPromise;
  }

  /** Derive the shared wrapping key between the daemon and a browser's announced public key. */
  async function sharedWith(browserPublicKey: string): Promise<CryptoKeyHandle> {
    return deriveSharedKey(
      await identityPrivateKey(),
      await importIdentityPublicKey(browserPublicKey),
    );
  }

  // sessionId -> Promise<content key (AES-GCM, extractable so it can be wrapped)>. Presence = E2E session.
  const contentKeys = new Map<string, Promise<CryptoKeyHandle>>();
  function requireKey(sessionId: string): Promise<CryptoKeyHandle> {
    const key = contentKeys.get(sessionId);
    if (key === undefined) throw new Error(`no content key for session ${sessionId}`);
    return key;
  }

  return {
    enabled: privateKeyBase64 !== undefined,

    isEncrypted(sessionId): boolean {
      return contentKeys.has(sessionId);
    },

    async decryptLaunch(envelope): Promise<unknown> {
      if (envelope.sender_public_key === undefined) {
        throw new Error('launch is missing sender_public_key');
      }
      return openPayload(envelope, await sharedWith(envelope.sender_public_key));
    },

    establish(sessionId): void {
      if (!contentKeys.has(sessionId)) contentKeys.set(sessionId, generateContentKey(true));
    },

    async keyDelivery(sessionId, browserPublicKey): Promise<EncryptedEnvelopeFields> {
      const rawKey = await exportContentKey(await requireKey(sessionId));
      return sealPayload({ key: rawKey }, await sharedWith(browserPublicKey));
    },

    async encrypt(sessionId, payload): Promise<EncryptedEnvelopeFields> {
      return sealPayload(payload, await requireKey(sessionId));
    },

    async decrypt(envelope): Promise<unknown> {
      if (envelope.session_id === undefined) {
        throw new Error('cannot decrypt a session-less envelope');
      }
      return openPayload(envelope, await requireKey(envelope.session_id));
    },
  };
}
