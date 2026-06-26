import {
  deriveSharedKey,
  exportIdentityPublicKey,
  importContentKey,
  importIdentityPublicKey,
  openPayload,
  sealPayload,
  sessionKeyPayloadSchema,
  type CryptoKeyHandle,
  type CryptoKeyPairHandle,
  type EncryptedEnvelopeFields,
  type Envelope,
} from '@telecode/protocol';

import { loadOrCreateIdentityKeyPair } from './keystore';

/**
 * Browser side of the E2E session cipher (Phase 3, migrated to WebCrypto in Phase 4) — the mirror of the
 * daemon's `session-cipher`. The browser holds an X25519 identity keypair whose **private key is a
 * non-extractable `CryptoKey`** (XSS can use it to decrypt but never read the bytes; persisted in Phase 4
 * Task 7) and the daemon's public key (from the device list). Per session it: seals the `session.launch`
 * to the daemon (ECDH→HKDF→AES-GCM), unwraps the per-session content key the daemon delivers
 * (`session.key`) into a non-extractable AES-GCM key, encrypts follow-ups / decisions under it, and
 * decrypts the streamed frames. The relay only ever sees ciphertext. All crypto routes through
 * `@telecode/protocol`.
 *
 * `enabled` is false when there is no daemon public key (a device paired before E2E): then the connection
 * stays cleartext and this cipher is a no-op, preserving the pre-E2E path.
 */
export interface BrowserSessionCipher {
  /** Whether E2E is available (the daemon registered a public key at pairing). */
  readonly enabled: boolean;
  /** This browser's identity public key (base64) to announce on launch/subscribe; undefined if disabled. */
  publicKey(): Promise<string | undefined>;
  /** Seal a launch payload to the daemon, returning the wire fields + the announced browser pubkey. */
  sealLaunch(payload: unknown): Promise<EncryptedEnvelopeFields & { senderPublicKey: string }>;
  /** Unwrap + store the content key from an inbound `session.key` envelope. */
  receiveKey(envelope: Envelope): Promise<void>;
  /** Whether a content key has been established for `sessionId`. */
  isEncrypted(sessionId: string): boolean;
  /** Seal a payload under the session's content key (AES-GCM). */
  encrypt(sessionId: string, payload: unknown): Promise<EncryptedEnvelopeFields>;
  /**
   * Decrypt an inbound frame's payload under its session content key. Returns `{ decrypted: false }` when
   * the frame is not encrypted (empty nonce / non-string payload — e.g. a relay-generated control
   * message), so the caller uses the envelope as-is.
   */
  tryDecrypt(
    envelope: Envelope,
  ): Promise<{ decrypted: true; payload: unknown } | { decrypted: false }>;
}

export function createBrowserSessionCipher(
  daemonPublicKey: string | null | undefined,
  // By default the identity keypair is loaded from (or created in) IndexedDB, so it persists across
  // reopens — a same-device reload reuses the same non-extractable key (Phase 4 Task 7). Tests inject one.
  keyPairFactory: () => Promise<CryptoKeyPairHandle> = loadOrCreateIdentityKeyPair,
): BrowserSessionCipher {
  const enabled = Boolean(daemonPublicKey);
  // The daemon's public key, imported once on first use.
  let daemonKeyPromise: Promise<CryptoKeyHandle> | null = null;
  function daemonKey(): Promise<CryptoKeyHandle> {
    if (!daemonPublicKey) throw new Error('no daemon public key for E2E');
    daemonKeyPromise ??= importIdentityPublicKey(daemonPublicKey);
    return daemonKeyPromise;
  }

  // The identity keypair, generated lazily once and reused for the connection's lifetime.
  let keyPairPromise: Promise<CryptoKeyPairHandle> | null = null;
  function keyPair(): Promise<CryptoKeyPairHandle> {
    keyPairPromise ??= keyPairFactory();
    return keyPairPromise;
  }

  /** Derive the shared wrapping key between this browser and the daemon. */
  async function sharedKey(): Promise<CryptoKeyHandle> {
    return deriveSharedKey((await keyPair()).privateKey, await daemonKey());
  }

  // sessionId -> the unwrapped content key (non-extractable AES-GCM). Presence marks an E2E session.
  const contentKeys = new Map<string, CryptoKeyHandle>();
  function requireKey(sessionId: string): CryptoKeyHandle {
    const key = contentKeys.get(sessionId);
    if (key === undefined) throw new Error(`no content key for session ${sessionId}`);
    return key;
  }

  return {
    enabled,

    async publicKey(): Promise<string | undefined> {
      if (!enabled) return undefined;
      return exportIdentityPublicKey((await keyPair()).publicKey);
    },

    async sealLaunch(payload): Promise<EncryptedEnvelopeFields & { senderPublicKey: string }> {
      if (!enabled) throw new Error('no daemon public key for E2E');
      const sealed = await sealPayload(payload, await sharedKey());
      return {
        ...sealed,
        senderPublicKey: await exportIdentityPublicKey((await keyPair()).publicKey),
      };
    },

    async receiveKey(envelope): Promise<void> {
      if (!enabled || envelope.session_id === undefined) return;
      const unwrapped = sessionKeyPayloadSchema.parse(
        await openPayload(envelope, await sharedKey()),
      );
      // Import the content key as non-extractable so it, too, can't be read back out of the browser.
      contentKeys.set(envelope.session_id, await importContentKey(unwrapped.key, false));
    },

    isEncrypted(sessionId): boolean {
      return contentKeys.has(sessionId);
    },

    encrypt(sessionId, payload): Promise<EncryptedEnvelopeFields> {
      return sealPayload(payload, requireKey(sessionId));
    },

    async tryDecrypt(
      envelope,
    ): Promise<{ decrypted: true; payload: unknown } | { decrypted: false }> {
      const sessionId = envelope.session_id;
      if (
        sessionId === undefined ||
        envelope.nonce === '' ||
        typeof envelope.payload !== 'string' ||
        !contentKeys.has(sessionId)
      ) {
        return { decrypted: false };
      }
      return { decrypted: true, payload: await openPayload(envelope, requireKey(sessionId)) };
    },
  };
}
