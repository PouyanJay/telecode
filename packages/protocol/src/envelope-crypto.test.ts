import { describe, expect, it } from 'vitest';

import { parsePlaintext, requireCiphertext } from './envelope-crypto';
import { ProtocolError } from './errors';

/**
 * Format-level guards shared by every E2E decrypt path: narrow a received envelope to its ciphertext
 * string and JSON-parse a decrypted plaintext, each surfacing a {@link ProtocolError} on bad input. The
 * seal/open round-trip itself is covered in `webcrypto.test.ts`.
 */
describe('requireCiphertext', () => {
  it('returns the ciphertext string when present', () => {
    expect(requireCiphertext({ payload: 'abc' })).toBe('abc');
  });

  it('throws a ProtocolError for a non-string or absent payload', () => {
    expect(() => requireCiphertext({ payload: 42 })).toThrow(ProtocolError);
    expect(() => requireCiphertext({})).toThrow(ProtocolError);
  });
});

describe('parsePlaintext', () => {
  it('parses valid JSON', () => {
    expect(parsePlaintext('{"a":1}')).toEqual({ a: 1 });
  });

  it('throws a ProtocolError (not a raw SyntaxError) on non-JSON', () => {
    expect(() => parsePlaintext('not json')).toThrow(ProtocolError);
  });
});
