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

describe('echoPayloadSchema', () => {
  it('validates a text payload', () => {
    expect(echoPayloadSchema.parse({ text: 'ok' }).text).toBe('ok');
  });

  it('rejects a non-string text', () => {
    expect(echoPayloadSchema.safeParse({ text: 42 }).success).toBe(false);
  });
});
