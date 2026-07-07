import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES } from './envelope';
import { workspaceReapRequestPayloadSchema, workspaceReapStatePayloadSchema } from './session';

/**
 * `workspace.reap` / `workspace.reap.state` (branch-actions T3): the delete flow's opt-in removal
 * of a session's worktree + branch. Device-scoped box-sealed RPC like `adopt.config` — workspace
 * paths and branch names never reach the relay in the clear; the envelope carries only ciphertext.
 * The state reply is a discriminated union: success carries no code, refusal always carries one.
 */
describe('workspace.reap payloads', () => {
  it('registers both message types', () => {
    expect(MESSAGE_TYPES).toContain('workspace.reap');
    expect(MESSAGE_TYPES).toContain('workspace.reap.state');
  });

  it('accepts a reap request for one session', () => {
    const parsed = workspaceReapRequestPayloadSchema.parse({
      sessionId: '7c9e6679-7425-40de-963d-2f1b2c8a0f1e',
    });
    expect(parsed.sessionId).toBe('7c9e6679-7425-40de-963d-2f1b2c8a0f1e');
  });

  it('rejects a request without a real session id', () => {
    expect(workspaceReapRequestPayloadSchema.safeParse({}).success).toBe(false);
    expect(workspaceReapRequestPayloadSchema.safeParse({ sessionId: 'nope' }).success).toBe(false);
    expect(workspaceReapRequestPayloadSchema.safeParse({ sessionId: '../escape' }).success).toBe(
      false,
    );
  });

  it('accepts a success state (no code) and a coded refusal', () => {
    const sid = '7c9e6679-7425-40de-963d-2f1b2c8a0f1e';
    expect(workspaceReapStatePayloadSchema.parse({ sessionId: sid, ok: true })).toEqual({
      sessionId: sid,
      ok: true,
    });
    for (const code of ['unknown-session', 'not-reapable', 'dirty', 'failed']) {
      expect(
        workspaceReapStatePayloadSchema.safeParse({ sessionId: sid, ok: false, code }).success,
      ).toBe(true);
    }
  });

  it('rejects a refusal without a code, and an unknown code', () => {
    const sid = '7c9e6679-7425-40de-963d-2f1b2c8a0f1e';
    expect(workspaceReapStatePayloadSchema.safeParse({ sessionId: sid, ok: false }).success).toBe(
      false,
    );
    expect(
      workspaceReapStatePayloadSchema.safeParse({ sessionId: sid, ok: false, code: 'later' })
        .success,
    ).toBe(false);
    // A success carrying extra keys still parses (lenient by design — additive wire evolution);
    // the stray key is stripped, never trusted.
    const parsed = workspaceReapStatePayloadSchema.parse({ sessionId: sid, ok: true, extra: 1 });
    expect(parsed).toEqual({ sessionId: sid, ok: true });
  });
});
