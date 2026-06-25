import { describe, expect, it } from 'vitest';

import { generateKeyPair } from './crypto';
import {
  openEnvelopePayload,
  parsePlaintext,
  requireCiphertext,
  sealEnvelopePayload,
} from './envelope-crypto';
import { ProtocolError } from './errors';

/**
 * The box-based envelope seam: seal a payload to a recipient and open it back, mapping to the wire
 * envelope's `{ payload, nonce }`. Covers the happy round-trip plus the security/precondition error
 * paths (non-ciphertext payload, wrong recipient, tampered ciphertext, non-JSON plaintext) — each must
 * surface as a {@link ProtocolError}.
 */
describe('sealEnvelopePayload / openEnvelopePayload', () => {
  it('round-trips a JSON payload from sender to recipient', async () => {
    const sender = await generateKeyPair();
    const recipient = await generateKeyPair();

    const sealed = await sealEnvelopePayload(
      { prompt: 'hello' },
      recipient.publicKey,
      sender.privateKey,
    );
    expect(typeof sealed.payload).toBe('string');
    expect(JSON.stringify(sealed)).not.toContain('hello');

    const opened = await openEnvelopePayload(sealed, sender.publicKey, recipient.privateKey);
    expect(opened).toEqual({ prompt: 'hello' });
  });

  it('throws a ProtocolError when the payload is not a ciphertext string', async () => {
    const sender = await generateKeyPair();
    const recipient = await generateKeyPair();
    await expect(
      openEnvelopePayload(
        { payload: { not: 'ciphertext' }, nonce: '' },
        sender.publicKey,
        recipient.privateKey,
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('throws when opened by the wrong recipient', async () => {
    const sender = await generateKeyPair();
    const recipient = await generateKeyPair();
    const intruder = await generateKeyPair();
    const sealed = await sealEnvelopePayload({ secret: 1 }, recipient.publicKey, sender.privateKey);

    await expect(
      openEnvelopePayload(sealed, sender.publicKey, intruder.privateKey),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('throws on a tampered ciphertext', async () => {
    const sender = await generateKeyPair();
    const recipient = await generateKeyPair();
    const sealed = await sealEnvelopePayload({ secret: 1 }, recipient.publicKey, sender.privateKey);
    const tampered = { ...sealed, payload: `${sealed.payload.slice(0, -2)}AA` };

    await expect(
      openEnvelopePayload(tampered, sender.publicKey, recipient.privateKey),
    ).rejects.toBeInstanceOf(ProtocolError);
  });
});

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
