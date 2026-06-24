import nacl from 'tweetnacl';

/**
 * E2E crypto helpers — X25519 authenticated encryption (NaCl `box`, via tweetnacl).
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

/** Generate an X25519 keypair (one per device on first run; per browser session). */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** Encrypt `plaintext` from the sender to the recipient (authenticated). */
export async function seal(
  plaintext: string,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): Promise<SealedMessage> {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    utf8Encoder.encode(plaintext),
    nonce,
    recipientPublicKey,
    senderPrivateKey,
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

/**
 * Decrypt a {@link SealedMessage}. Rejects if the keys don't match or the ciphertext was
 * tampered with (NaCl authenticates before decrypting and returns null on failure).
 */
export async function open(
  sealed: SealedMessage,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<string> {
  const nonce = fromBase64(sealed.nonce);
  const ciphertext = fromBase64(sealed.ciphertext);
  const plaintext = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientPrivateKey);
  if (plaintext === null) {
    throw new Error('decryption failed: wrong key pair or tampered ciphertext');
  }
  return utf8Decoder.decode(plaintext);
}
