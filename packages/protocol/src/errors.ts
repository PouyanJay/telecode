/**
 * Base error for the `@telecode/protocol` layer. The crypto/envelope seam throws this (with the
 * underlying failure attached via `cause`) so callers — the daemon and relay — can distinguish a
 * protocol-layer failure (bad ciphertext, failed decryption, non-JSON plaintext) from a transport or
 * framework error with a single `instanceof ProtocolError` check, without inspecting message strings.
 */
export class ProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}
