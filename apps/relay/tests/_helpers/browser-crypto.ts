import {
  deriveSharedKey,
  encodeKey,
  importContentKey,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  openPayload,
  sealPayload,
  sessionKeyPayloadSchema,
  type CryptoKeyHandle,
  type EncryptedEnvelopeFields,
} from '@telecode/protocol';

/**
 * Browser-side E2E simulation over WebCrypto (Phase 4) for the relay integration tests — mirrors the real
 * browser cipher with the same shapes the old tweetnacl helpers had, so the scenarios read unchanged.
 * Keys are raw X25519 bytes (tweetnacl-format from `generateKeyPair`), imported into WebCrypto here
 * exactly as the daemon does — so these tests exercise the real on-the-wire AES-GCM handshake.
 */
type SealedFields = { readonly payload?: unknown; readonly nonce: string };

/** Derive the AES-GCM key two raw X25519 keys agree on (ECDH→HKDF). */
async function shared(privateKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKeyHandle> {
  return deriveSharedKey(
    await importIdentityPrivateKey(encodeKey(privateKey)),
    await importIdentityPublicKey(encodeKey(publicKey)),
  );
}

/** Seal a JSON payload to `recipientPublicKey` (the box-seam shape; AES-GCM under the derived key). */
export async function sealEnvelopePayload(
  payload: unknown,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): Promise<EncryptedEnvelopeFields> {
  return sealPayload(payload, await shared(senderPrivateKey, recipientPublicKey));
}

/** Open a sealed envelope from `senderPublicKey` (the inverse; ECDH is symmetric). */
export async function openEnvelopePayload(
  envelope: SealedFields,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<unknown> {
  return openPayload(envelope, await shared(recipientPrivateKey, senderPublicKey));
}

/** Unwrap the daemon-delivered content key from a `session.key` envelope, returning its base64 form. */
export async function unwrapContentKey(
  envelope: SealedFields,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<string> {
  return sessionKeyPayloadSchema.parse(
    await openEnvelopePayload(envelope, senderPublicKey, recipientPrivateKey),
  ).key;
}

/** Decrypt a streamed frame under the (base64) session content key. */
export async function decryptWithContentKey(
  envelope: SealedFields,
  contentKey: string,
): Promise<unknown> {
  return openPayload(envelope, await importContentKey(contentKey, false));
}
