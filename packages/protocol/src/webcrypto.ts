import type { webcrypto } from 'node:crypto';

import { decodeKey, encodeKey } from './crypto';
import { parsePlaintext, requireCiphertext, type EncryptedEnvelopeFields } from './envelope-crypto';
import { ProtocolError } from './errors';

// Module-local aliases for the WebCrypto handle types. `@types/node` declares these inside the
// `webcrypto` namespace (not as globals), and we can't add the DOM lib without breaking Node's timer
// types — so we alias here. They are structurally identical to the browser's global `CryptoKey`/
// `CryptoKeyPair`, so a value of either flavour is interchangeable across the daemon (Node) and the web.
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

/**
 * WebCrypto E2E primitives (Phase 4): **ECDH(X25519) → HKDF-SHA256 → AES-256-GCM**. These replace
 * tweetnacl `box`/`secretbox` for the E2E *session* path (launch seal, content-key wrap, stream payloads)
 * so the browser's identity private key can be held as a **non-extractable `CryptoKey`** — XSS can use it
 * to decrypt while on the origin but can never read or exfiltrate the raw bytes. (The relay's at-rest
 * OAuth-token crypto stays on `secretbox` in `crypto.ts` — a separate concern.)
 *
 * Runs on the Web Crypto API present in Node 22+, modern browsers, and Vite — no native deps, preserving
 * the cross-environment portability that motivated tweetnacl. The X25519 key material is the same curve
 * tweetnacl uses, so the daemon's existing raw keys import unchanged (no re-pairing).
 *
 * Wire format is unchanged: `{ payload, nonce }` where `payload` is base64 AES-GCM ciphertext (with its
 * 16-byte auth tag appended) and `nonce` is the base64 12-byte GCM IV. The relay forwards ciphertext only.
 */

const subtle = globalThis.crypto.subtle;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// HKDF context. A fixed salt + info is the standard construction for ECDH key agreement — the ephemeral
// (or per-device) X25519 keys supply the freshness; per-message freshness comes from the random GCM IV.
const HKDF_INFO = utf8Encoder.encode('telecode/session-key/v1');
const HKDF_SALT = new Uint8Array(0);
const GCM_IV_BYTES = 12;

// PKCS8 DER prefix for an X25519 private key (RFC 8410): SEQ{ INTEGER 0, AlgId{ 1.3.101.110 },
// OCTET STRING{ OCTET STRING{ <32-byte key> } } }. Prepending it to a raw 32-byte scalar yields a
// pkcs8 blob WebCrypto can import — this is how the daemon's tweetnacl-format key loads unchanged.
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Decode base64 into a guaranteed `ArrayBuffer`-backed view. The DOM's `BufferSource` (web build) rejects
 * a `SharedArrayBuffer`-backed `Uint8Array`, so copying into a fresh buffer keeps WebCrypto happy in both
 * the browser and Node.
 */
function bytes(base64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(decodeKey(base64));
}

/**
 * Generate an X25519 identity keypair. `extractablePrivate: false` makes the private key impossible to
 * read out of the environment (the browser's non-extractable goal); the daemon passes `true` so it can
 * export and persist its key to `~/.telecode/credentials.json`.
 */
export async function generateIdentityKeyPair(extractablePrivate: boolean): Promise<CryptoKeyPair> {
  return (await subtle.generateKey({ name: 'X25519' }, extractablePrivate, [
    'deriveBits',
  ])) as CryptoKeyPair;
}

/** Export an X25519 public key as raw base64 (32 bytes) to announce on the wire / store. */
export async function exportIdentityPublicKey(key: CryptoKey): Promise<string> {
  return encodeKey(new Uint8Array(await subtle.exportKey('raw', key)));
}

/** Import a peer's raw base64 X25519 public key (32 bytes) for ECDH. */
export async function importIdentityPublicKey(rawBase64: string): Promise<CryptoKey> {
  return subtle.importKey('raw', bytes(rawBase64), { name: 'X25519' }, true, []);
}

/**
 * Import a raw base64 X25519 private key (32 bytes, e.g. the daemon's persisted tweetnacl key) by wrapping
 * it in the fixed PKCS8 prefix. `extractable` defaults to false (the daemon re-exports nothing after load).
 */
export async function importIdentityPrivateKey(
  rawBase64: string,
  extractable = false,
): Promise<CryptoKey> {
  const raw = decodeKey(rawBase64);
  if (raw.length !== 32) {
    throw new ProtocolError(`X25519 private key must be 32 bytes, got ${raw.length}`);
  }
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_X25519_PREFIX, 0);
  pkcs8.set(raw, PKCS8_X25519_PREFIX.length);
  return subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, extractable, ['deriveBits']);
}

/**
 * Derive the shared AES-256-GCM key between an identity private key and a peer's public key:
 * X25519 ECDH → HKDF-SHA256 → AES-GCM. Both parties compute the same key. Used to seal the launch
 * (browser→daemon) and to wrap the per-session content key (daemon→browser). Non-extractable — it only
 * ever encrypts/decrypts, never leaves the environment.
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<CryptoKey> {
  const sharedBits = await subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256,
  );
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Mint a fresh per-session content key (AES-256-GCM). The daemon passes `extractable: true` so it can
 * export the key bytes to wrap them to each browser; a browser imports the unwrapped bytes with
 * `extractable: false` so the content key, too, can't be read back out once received.
 */
export async function generateContentKey(extractable: boolean): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** Import a raw base64 content key (32 bytes) as an AES-GCM key. */
export async function importContentKey(
  rawBase64: string,
  extractable: boolean,
): Promise<CryptoKey> {
  return subtle.importKey('raw', bytes(rawBase64), { name: 'AES-GCM' }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/** Export an (extractable) content key as raw base64 — the daemon uses this to wrap the key to a browser. */
export async function exportContentKey(key: CryptoKey): Promise<string> {
  return encodeKey(new Uint8Array(await subtle.exportKey('raw', key)));
}

/**
 * Seal a JSON-serializable payload under `key` (AES-256-GCM, fresh random IV), returning the envelope's
 * `{ payload, nonce }` fields. `key` is either a derived shared key (launch / content-key wrap) or a
 * session content key (the stream) — one primitive for every E2E frame.
 */
export async function sealPayload(
  payload: unknown,
  key: CryptoKey,
): Promise<EncryptedEnvelopeFields> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Encoder.encode(JSON.stringify(payload))),
  );
  return { payload: encodeKey(ciphertext), nonce: encodeKey(iv) };
}

/**
 * Open a received envelope's `payload`/`nonce` under `key` (AES-256-GCM) and JSON-parse it. Throws a
 * {@link ProtocolError} if the payload isn't a ciphertext string, if authentication fails (wrong key or
 * tampered ciphertext — GCM verifies the tag before returning), or if the plaintext isn't valid JSON.
 */
export async function openPayload(
  envelope: { readonly payload?: unknown; readonly nonce: string },
  key: CryptoKey,
): Promise<unknown> {
  const ciphertext = requireCiphertext(envelope);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(envelope.nonce) },
      key,
      bytes(ciphertext),
    );
  } catch (err) {
    throw new ProtocolError('failed to decrypt payload (wrong key or tampered ciphertext)', {
      cause: err,
    });
  }
  return parsePlaintext(utf8Decoder.decode(plaintext));
}
