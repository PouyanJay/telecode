import { describe, expect, it } from 'vitest';

import {
  echoPayloadSchema,
  envelopeSchema,
  makeEnvelope,
  parseEnvelope,
  PROTOCOL_VERSION,
  safeParseEnvelope,
} from './envelope';

const validWire = {
  v: 1,
  user_id: 'u_1',
  device_id: 'd_1',
  type: 'echo',
  nonce: '',
  payload: { text: 'hi' },
};

describe('protocol version', () => {
  it('is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('envelopeSchema', () => {
  it('parses a valid wire envelope', () => {
    const env = parseEnvelope(validWire);
    expect(env.type).toBe('echo');
    expect(env.user_id).toBe('u_1');
    expect(env.session_id).toBeUndefined();
  });

  it('accepts an optional session_id', () => {
    const env = parseEnvelope({ ...validWire, session_id: 's_1' });
    expect(env.session_id).toBe('s_1');
  });

  it('rejects a mismatched protocol version', () => {
    expect(() => parseEnvelope({ ...validWire, v: 2 })).toThrow();
  });

  it('rejects an empty user_id', () => {
    const result = safeParseEnvelope({ ...validWire, user_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown message type', () => {
    const result = safeParseEnvelope({ ...validWire, type: 'not.a.real.type' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { device_id: _omitted, ...withoutDeviceId } = validWire;
    expect(envelopeSchema.safeParse(withoutDeviceId).success).toBe(false);
  });
});

describe('makeEnvelope', () => {
  it('builds an envelope that round-trips through parseEnvelope', () => {
    const env = makeEnvelope({
      type: 'echo',
      userId: 'u_1',
      deviceId: 'd_1',
      payload: { text: 'round-trip' },
    });
    expect(env.v).toBe(PROTOCOL_VERSION);
    expect(env.nonce).toBe('');
    expect(() => parseEnvelope(env)).not.toThrow();
  });

  it('omits session_id when not provided (no undefined key)', () => {
    const env = makeEnvelope({ type: 'echo', userId: 'u', deviceId: 'd', payload: {} });
    expect('session_id' in env).toBe(false);
  });

  it('includes session_id when provided', () => {
    const env = makeEnvelope({
      type: 'session.subscribe',
      userId: 'u',
      deviceId: 'd',
      sessionId: 's_42',
      payload: {},
    });
    expect(env.session_id).toBe('s_42');
  });
});

// A well-formed base64 32-byte key (43 base64 chars + one `=` pad) — the shape encodeKey() produces.
const VALID_KEY = `${'A'.repeat(43)}=`;

describe('envelope E2E routing-metadata fields (Phase 3)', () => {
  it('accepts an optional cleartext status field (routing metadata for the relay)', () => {
    const env = parseEnvelope({ ...validWire, type: 'session.ended', status: 'done' });
    expect(env.status).toBe('done');
  });

  it('rejects an unknown status value', () => {
    expect(safeParseEnvelope({ ...validWire, status: 'nonsense' }).success).toBe(false);
  });

  it('accepts an optional sender_public_key (base64 32-byte ephemeral key)', () => {
    const env = parseEnvelope({ ...validWire, sender_public_key: VALID_KEY });
    expect(env.sender_public_key).toBe(VALID_KEY);
  });

  it('rejects a sender_public_key that is not a base64 32-byte key', () => {
    for (const bad of ['', 'cHVia2V5', `${'A'.repeat(44)}`, `${'!'.repeat(43)}=`]) {
      expect(
        safeParseEnvelope({ ...validWire, sender_public_key: bad }).success,
        `${JSON.stringify(bad)} must be rejected`,
      ).toBe(false);
    }
  });

  it('treats status and sender_public_key as absent by default', () => {
    const env = parseEnvelope(validWire);
    expect(env.status).toBeUndefined();
    expect(env.sender_public_key).toBeUndefined();
  });

  it('recognizes session.key as a valid message type', () => {
    expect(safeParseEnvelope({ ...validWire, type: 'session.key' }).success).toBe(true);
  });

  it('recognizes session.adopted as a valid message type (adopted sessions)', () => {
    expect(safeParseEnvelope({ ...validWire, type: 'session.adopted' }).success).toBe(true);
  });

  it('recognizes the free-form handover message types (Journey 4)', () => {
    for (const type of ['agent.handover', 'handover.answer', 'session.chained'] as const) {
      expect(safeParseEnvelope({ ...validWire, type }).success).toBe(true);
    }
  });
});

describe('makeEnvelope routing-metadata fields', () => {
  it('sets status and sender_public_key when provided', () => {
    const env = makeEnvelope({
      type: 'session.ended',
      userId: 'u',
      deviceId: 'd',
      sessionId: 's',
      status: 'error',
      senderPublicKey: VALID_KEY,
      payload: 'ciphertext',
    });
    expect(env.status).toBe('error');
    expect(env.sender_public_key).toBe(VALID_KEY);
  });

  it('omits status and sender_public_key keys when not provided', () => {
    const env = makeEnvelope({ type: 'echo', userId: 'u', deviceId: 'd', payload: {} });
    expect('status' in env).toBe(false);
    expect('sender_public_key' in env).toBe(false);
  });
});

describe('echoPayloadSchema', () => {
  it('validates a text payload', () => {
    expect(echoPayloadSchema.parse({ text: 'ok' }).text).toBe('ok');
  });

  it('rejects a non-string text', () => {
    expect(echoPayloadSchema.safeParse({ text: 42 }).success).toBe(false);
  });
});
