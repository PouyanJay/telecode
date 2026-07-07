import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, makeEnvelope } from './envelope';
import { sessionMetaPayloadSchema } from './session';
import { generateContentKey, openPayload, sealPayload } from './webcrypto';

/**
 * `session.meta` (ux Phase 6): the sealed session-identity frame. The schema is the wire contract for
 * the DECRYPTED payload; on the wire it travels AES-GCM-sealed under the per-session content key, so
 * the round-trip below is the real path a browser takes.
 */
describe('sessionMetaPayloadSchema', () => {
  it('is a registered message type', () => {
    expect(MESSAGE_TYPES).toContain('session.meta');
  });

  it('accepts full metadata', () => {
    const parsed = sessionMetaPayloadSchema.parse({
      title: 'fix the login bug',
      titleSource: 'derived',
      cwd: '/Users/me/dev/app',
      model: 'claude-sonnet-5',
      permissionMode: 'default',
      branch: 'telecode/fix-login-8f2a',
      ts: 1_751_700_000_000,
    });
    expect(parsed.title).toBe('fix the login bug');
    expect(parsed.titleSource).toBe('derived');
    expect(parsed.branch).toBe('telecode/fix-login-8f2a');
  });

  it('accepts a partial update (every field optional)', () => {
    expect(sessionMetaPayloadSchema.parse({ title: 'renamed', titleSource: 'user' })).toEqual({
      title: 'renamed',
      titleSource: 'user',
    });
    expect(sessionMetaPayloadSchema.parse({})).toEqual({});
  });

  it('rejects out-of-bounds and malformed fields', () => {
    expect(sessionMetaPayloadSchema.safeParse({ title: 'x'.repeat(513) }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ title: '' }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ titleSource: 'guessed' }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ permissionMode: 'yolo' }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ cwd: 'x'.repeat(1025) }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ ts: -1 }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ branch: '' }).success).toBe(false);
    expect(sessionMetaPayloadSchema.safeParse({ branch: 'x'.repeat(257) }).success).toBe(false);
  });

  it('round-trips sealed under a content key inside a valid envelope', async () => {
    const key = await generateContentKey(false);
    const meta = { title: 'ship it', titleSource: 'user' as const, cwd: '/repo' };
    const sealed = await sealPayload(meta, key);

    const envelope = makeEnvelope({
      type: 'session.meta',
      userId: 'user-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      payload: sealed.payload,
      nonce: sealed.nonce,
    });
    expect(typeof envelope.payload).toBe('string');
    expect(envelope.nonce).not.toBe('');

    const opened = sessionMetaPayloadSchema.parse(
      await openPayload({ payload: envelope.payload, nonce: envelope.nonce }, key),
    );
    expect(opened).toEqual(meta);
  });
});
