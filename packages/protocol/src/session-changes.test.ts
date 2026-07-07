import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, makeEnvelope } from './envelope';
import { MAX_CHANGED_FILES, sessionChangesPayloadSchema } from './session';
import { generateContentKey, openPayload, sealPayload } from './webcrypto';

/**
 * `session.changes` (branch-workflow Phase C): the session branch's diff vs its base, computed on the
 * daemon and sealed under the per-session content key — the rail's CHANGES panel is its only reader.
 * The schema is the wire contract for the DECRYPTED payload; the round-trip below is the real path a
 * browser takes. Counts are `null` when a file's ±N is unknowable (binary, untracked).
 */
describe('sessionChangesPayloadSchema', () => {
  it('is a registered message type', () => {
    expect(MESSAGE_TYPES).toContain('session.changes');
  });

  it('accepts a populated diff summary', () => {
    const parsed = sessionChangesPayloadSchema.parse({
      baseBranch: 'origin/main',
      files: [
        { path: 'src/app.ts', additions: 12, deletions: 3 },
        { path: 'assets/logo.png', additions: null, deletions: null },
      ],
      totalAdditions: 12,
      totalDeletions: 3,
      truncated: false,
      ts: 1_751_800_000_000,
    });
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[1]?.additions).toBeNull();
    expect(parsed.truncated).toBe(false);
  });

  it('accepts an empty diff (no changes yet)', () => {
    const parsed = sessionChangesPayloadSchema.parse({
      baseBranch: 'main',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    });
    expect(parsed.files).toEqual([]);
  });

  it('rejects out-of-bounds and malformed fields', () => {
    const base = { baseBranch: 'main', totalAdditions: 0, totalDeletions: 0, truncated: false };
    const file = (path: string) => ({ path, additions: 1, deletions: 0 });

    expect(sessionChangesPayloadSchema.safeParse({ ...base, files: [] }).success).toBe(true);
    // one over the shared file cap
    const tooMany = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => file(`f${i}.ts`));
    expect(sessionChangesPayloadSchema.safeParse({ ...base, files: tooMany }).success).toBe(false);
    // path bounds
    expect(
      sessionChangesPayloadSchema.safeParse({ ...base, files: [file('x'.repeat(513))] }).success,
    ).toBe(false);
    expect(sessionChangesPayloadSchema.safeParse({ ...base, files: [file('')] }).success).toBe(
      false,
    );
    // counts: negative and fractional are malformed; null is the honest "unknowable"
    expect(
      sessionChangesPayloadSchema.safeParse({
        ...base,
        files: [{ path: 'a.ts', additions: -1, deletions: 0 }],
      }).success,
    ).toBe(false);
    expect(
      sessionChangesPayloadSchema.safeParse({
        ...base,
        files: [{ path: 'a.ts', additions: 1.5, deletions: 0 }],
      }).success,
    ).toBe(false);
    // required envelope-level fields
    expect(
      sessionChangesPayloadSchema.safeParse({ ...base, files: [], baseBranch: '' }).success,
    ).toBe(false);
    expect(
      sessionChangesPayloadSchema.safeParse({ files: [], totalAdditions: 0, totalDeletions: 0 })
        .success,
    ).toBe(false);
    expect(
      sessionChangesPayloadSchema.safeParse({ ...base, files: [], totalAdditions: -1 }).success,
    ).toBe(false);
  });

  it('round-trips sealed under a content key inside a valid envelope', async () => {
    const key = await generateContentKey(false);
    const changes = {
      baseBranch: 'origin/main',
      files: [{ path: 'src/app.ts', additions: 2, deletions: 1 }],
      totalAdditions: 2,
      totalDeletions: 1,
      truncated: false,
    };
    const sealed = await sealPayload(changes, key);

    const envelope = makeEnvelope({
      type: 'session.changes',
      userId: 'user-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      payload: sealed.payload,
      nonce: sealed.nonce,
    });
    expect(typeof envelope.payload).toBe('string');
    expect(envelope.nonce).not.toBe('');

    const opened = sessionChangesPayloadSchema.parse(
      await openPayload({ payload: envelope.payload, nonce: envelope.nonce }, key),
    );
    expect(opened).toEqual(changes);
  });
});
