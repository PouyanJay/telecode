import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, makeEnvelope, parseEnvelope } from './envelope';
import { sessionResumeNewPayloadSchema } from './session';

/**
 * `session.resume_new` (ux Phase 6 T8): a browser asks the daemon to continue a TERMINAL session as a
 * NEW, linked one (fork-resume when the conversation is still resumable; fresh launch otherwise). The
 * payload is sealed exactly like `session.launch` (box-sealed to the daemon) — the parent's content key
 * may be lost (needs_restart after a restart), so the frame must never depend on it. `clientRef` rides
 * the child's `session.started` so the acting browser can navigate, exactly like a launch.
 */
describe('session.resume_new wire contract (T8)', () => {
  it('is a known message type that round-trips the envelope', () => {
    expect(MESSAGE_TYPES).toContain('session.resume_new');
    const envelope = makeEnvelope({
      type: 'session.resume_new',
      userId: 'u1',
      deviceId: 'd1',
      sessionId: 'parent-1',
      payload: 'CIPHERTEXT',
      nonce: 'NONCE',
    });
    expect(parseEnvelope(JSON.parse(JSON.stringify(envelope))).type).toBe('session.resume_new');
  });

  it('accepts a prompt with an optional clientRef', () => {
    expect(
      sessionResumeNewPayloadSchema.parse({ prompt: 'keep going', clientRef: 'ref-1' }),
    ).toEqual({ prompt: 'keep going', clientRef: 'ref-1' });
    expect(sessionResumeNewPayloadSchema.parse({ prompt: 'keep going' })).toEqual({
      prompt: 'keep going',
    });
  });

  it('rejects an empty prompt and a missing prompt', () => {
    expect(sessionResumeNewPayloadSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(sessionResumeNewPayloadSchema.safeParse({}).success).toBe(false);
    expect(sessionResumeNewPayloadSchema.safeParse({ clientRef: 'r' }).success).toBe(false);
  });

  it('carries an optional base + name for a fork onto a chosen branch (branch-actions T5)', () => {
    expect(
      sessionResumeNewPayloadSchema.parse({
        prompt: 'continue over there',
        baseBranch: 'telecode/parent-work-ab12',
        branchName: 'feat/continued',
      }),
    ).toEqual({
      prompt: 'continue over there',
      baseBranch: 'telecode/parent-work-ab12',
      branchName: 'feat/continued',
    });
    // The same conservative ref-name rule as the launch's fields — these reach git argv.
    expect(
      sessionResumeNewPayloadSchema.safeParse({ prompt: 'x', baseBranch: '-rf' }).success,
    ).toBe(false);
    expect(
      sessionResumeNewPayloadSchema.safeParse({ prompt: 'x', branchName: 'a..b' }).success,
    ).toBe(false);
  });
});

describe('session.resume_new permission mode (continuation-permission-mode fix)', () => {
  it('carries an optional permissionMode — a NEW linked session starts in the mode the browser asks for', () => {
    const parsed = sessionResumeNewPayloadSchema.parse({
      prompt: 'continue',
      permissionMode: 'bypassPermissions',
    });
    expect(parsed.permissionMode).toBe('bypassPermissions');
  });

  it('keeps the field optional (older webs omit it — the daemon then inherits the parent mode)', () => {
    expect(sessionResumeNewPayloadSchema.parse({ prompt: 'go' }).permissionMode).toBeUndefined();
  });

  it('rejects an unknown mode', () => {
    expect(
      sessionResumeNewPayloadSchema.safeParse({ prompt: 'go', permissionMode: 'yolo' }).success,
    ).toBe(false);
  });
});
