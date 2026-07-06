import { describe, expect, it } from 'vitest';

import { deviceApproveResponseSchema, deviceCodeRequestSchema } from './device-auth';

describe('deviceCodeRequestSchema', () => {
  it('accepts an optional os descriptor alongside name + public key', () => {
    const parsed = deviceCodeRequestSchema.parse({
      name: 'studio-mbp',
      public_key: 'cGs=',
      os: 'macOS 15.4',
    });
    expect(parsed.os).toBe('macOS 15.4');
  });

  it('treats os as optional (a daemon that does not report it still pairs)', () => {
    expect(deviceCodeRequestSchema.parse({ name: 'rig' }).os).toBeUndefined();
  });

  it('rejects an over-long os string (bounds what gets stored + shown)', () => {
    expect(deviceCodeRequestSchema.safeParse({ os: 'x'.repeat(65) }).success).toBe(false);
  });

  it('accepts optional prior_device_token restore evidence (additive — old daemons omit it)', () => {
    const parsed = deviceCodeRequestSchema.parse({ name: 'rig', prior_device_token: 'dt_prior' });
    expect(parsed.prior_device_token).toBe('dt_prior');
    expect(deviceCodeRequestSchema.parse({ name: 'rig' }).prior_device_token).toBeUndefined();
  });

  it('rejects an empty prior_device_token (evidence must be a real token, not a blank claim)', () => {
    expect(deviceCodeRequestSchema.safeParse({ prior_device_token: '' }).success).toBe(false);
  });

  it('bounds the device name (it is stored and rendered in the UI)', () => {
    expect(deviceCodeRequestSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(deviceCodeRequestSchema.safeParse({ name: 'x'.repeat(200) }).success).toBe(true);
  });
});

describe('deviceApproveResponseSchema', () => {
  it('accepts a restore result with the device name, and a fresh pair with null', () => {
    expect(
      deviceApproveResponseSchema.parse({ ok: true, restored: true, device_name: 'mbp' }),
    ).toEqual({ ok: true, restored: true, device_name: 'mbp' });
    expect(
      deviceApproveResponseSchema.parse({ ok: true, restored: false, device_name: null }),
    ).toEqual({ ok: true, restored: false, device_name: null });
  });

  it('rejects a non-true ok and a missing device_name (null must be explicit, not absent)', () => {
    expect(
      deviceApproveResponseSchema.safeParse({ ok: false, restored: false, device_name: null })
        .success,
    ).toBe(false);
    expect(deviceApproveResponseSchema.safeParse({ ok: true, restored: false }).success).toBe(
      false,
    );
  });
});
