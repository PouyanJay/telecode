import { describe, expect, it } from 'vitest';

import { deviceCodeRequestSchema } from './device-auth';

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
});
