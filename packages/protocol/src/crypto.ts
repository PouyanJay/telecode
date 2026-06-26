import nacl from 'tweetnacl';

/**
 * Crypto helpers (NaCl, via tweetnacl) — two primitives, both authenticated:
 *  - `box` (X25519-XSalsa20-Poly1305): E2E encryption between two parties — {@link seal}/{@link open}.
 *  - `secretbox` (XSalsa20-Poly1305): symmetric at-rest encryption under one key —
 *    {@link sealSecret}/{@link openSecret}. Used by the relay to protect the user's stored OAuth token.
 *
 * Both share the {@link SealedMessage} `{nonce, ciphertext}` base64 shape. All encryption MUST go through
 * these helpers — never ad hoc (architecture invariant: crypto lives in `@telecode/protocol`).
 *
 * tweetnacl is the plan's accepted libsodium-family option; chosen over `libsodium-wrappers`
 * because its WASM ESM build does not resolve cleanly under Vite/Vitest (and would resurface
 * in the SvelteKit browser build). tweetnacl is pure-JS and behaves identically in Node, Vite,
 * and the browser. `box` is X25519-XSalsa20-Poly1305 with a 24-byte nonce — the same primitive
 * libsodium's `crypto_box` exposes, so the wire format is unchanged.
 *
 * base64/UTF-8 conversion uses cross-environment globals (`btoa`/`atob`, `TextEncoder`/
 * `TextDecoder`) so the package works unchanged in Node and the browser with no extra deps.
 *
 * Phase 0 ships these to de-risk the crypto dependency and give the protocol package a real
 * round-trip test; the relay echo itself stays plaintext until E2E lands in Phase 3. All payload
 * encryption MUST go through these helpers — never ad hoc. The API is async so the implementation
 * can be swapped (e.g. for a WASM backend) without changing call sites.
 */

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** A sealed payload as it travels on the wire — base64 nonce + ciphertext. */
export interface SealedMessage {
  readonly nonce: string;
  readonly ciphertext: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode a key (e.g. an X25519 public key) as base64 for the wire / storage. */
export function encodeKey(key: Uint8Array): string {
  return toBase64(key);
}

/** Decode a base64 key back into bytes. */
export function decodeKey(value: string): Uint8Array {
  return fromBase64(value);
}

/** No-op for tweetnacl (no async init); kept for API symmetry with WASM backends. */
export async function ready(): Promise<void> {}

/**
 * Generate an X25519 keypair (the daemon's device identity, persisted at pairing). The raw key bytes are
 * a valid X25519 keypair that WebCrypto imports for the E2E handshake (see `webcrypto.ts`) — keeping
 * keygen here means existing stored daemon keys load unchanged. The browser instead generates a
 * non-extractable WebCrypto keypair directly.
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** Generate a 32-byte symmetric key for {@link sealSecret} (e.g. the relay's at-rest token key). */
export function generateSecretKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

/** Symmetrically encrypt `plaintext` under `key` (authenticated; fresh random nonce per call). */
export async function sealSecret(plaintext: string, key: Uint8Array): Promise<SealedMessage> {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(utf8Encoder.encode(plaintext), nonce, key);
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

/**
 * Decrypt a {@link sealSecret} message under `key`. Rejects if the key is wrong or the ciphertext was
 * tampered with (NaCl authenticates before decrypting and returns null on failure).
 */
export async function openSecret(sealed: SealedMessage, key: Uint8Array): Promise<string> {
  const plaintext = nacl.secretbox.open(
    fromBase64(sealed.ciphertext),
    fromBase64(sealed.nonce),
    key,
  );
  if (plaintext === null) {
    throw new Error('decryption failed: wrong key or tampered ciphertext');
  }
  return utf8Decoder.decode(plaintext);
}
