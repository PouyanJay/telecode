import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, makeEnvelope } from './envelope';
import { sessionTitlePayloadSchema } from './session';
import { generateContentKey, openPayload, sealPayload } from './webcrypto';

/**
 * `session.title` (ux Phase 6 T6): the user's rename override, kept SEPARATE from `session.meta` so the
 * two never race. The schema is the wire contract for the DECRYPTED SET payload (`{ title }`, sealed under
 * the per-session content key) OR the cleartext RESET marker (`{ reset: true }`, which carries no secret).
 */
describe('sessionTitlePayloadSchema', () => {
  it('is a registered message type', () => {
    expect(MESSAGE_TYPES).toContain('session.title');
  });

  it('accepts a set (a bounded title)', () => {
    expect(sessionTitlePayloadSchema.parse({ title: 'My deploy run' })).toEqual({
      title: 'My deploy run',
    });
  });

  it('accepts a reset marker', () => {
    expect(sessionTitlePayloadSchema.parse({ reset: true })).toEqual({ reset: true });
  });

  it('rejects an empty or over-long title, and a malformed reset', () => {
    expect(sessionTitlePayloadSchema.safeParse({ title: '' }).success).toBe(false);
    expect(sessionTitlePayloadSchema.safeParse({ title: 'x'.repeat(513) }).success).toBe(false);
    expect(sessionTitlePayloadSchema.safeParse({ reset: false }).success).toBe(false);
    expect(sessionTitlePayloadSchema.safeParse({}).success).toBe(false);
  });

  it('round-trips a SET sealed under a content key inside a valid envelope', async () => {
    const key = await generateContentKey(false);
    const override = { title: 'renamed by the user' };
    const sealed = await sealPayload(override, key);

    const envelope = makeEnvelope({
      type: 'session.title',
      userId: 'user-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      payload: sealed.payload,
      nonce: sealed.nonce,
    });
    expect(typeof envelope.payload).toBe('string');
    expect(envelope.nonce).not.toBe('');

    const opened = sessionTitlePayloadSchema.parse(
      await openPayload({ payload: envelope.payload, nonce: envelope.nonce }, key),
    );
    expect(opened).toEqual(override);
  });

  it('carries the RESET marker as cleartext (no secret to seal)', () => {
    const envelope = makeEnvelope({
      type: 'session.title',
      userId: 'user-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      payload: { reset: true },
    });
    expect(envelope.nonce).toBe('');
    expect(sessionTitlePayloadSchema.parse(envelope.payload)).toEqual({ reset: true });
  });
});
