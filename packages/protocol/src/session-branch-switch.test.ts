import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES } from './envelope';
import {
  BRANCH_SWITCH_FAILURE_CODES,
  repoBranchesRequestPayloadSchema,
  repoBranchesStatePayloadSchema,
  sessionBranchStatePayloadSchema,
  sessionBranchSwitchPayloadSchema,
} from './session';

/**
 * Between-turns branch switch (branch-actions T4): `session.branch.switch` asks, sealed under the
 * session content key; `session.branch.state` settles. The branch name is validated at the wire
 * boundary — it reaches git argv on the daemon (execFile array-args is the floor; this is defense
 * on top, the same rule as the launch's branch fields).
 */
describe('session.branch.switch payloads', () => {
  it('registers both message types', () => {
    expect(MESSAGE_TYPES).toContain('session.branch.switch');
    expect(MESSAGE_TYPES).toContain('session.branch.state');
  });

  it('accepts a real branch name and rejects git-hostile ones', () => {
    expect(sessionBranchSwitchPayloadSchema.parse({ branch: 'feat/other' })).toEqual({
      branch: 'feat/other',
    });
    for (const hostile of [
      '',
      '-rf',
      'a..b',
      'has space',
      'bad~ref',
      'trailing/',
      'x'.repeat(257),
    ]) {
      expect(sessionBranchSwitchPayloadSchema.safeParse({ branch: hostile }).success).toBe(false);
    }
  });

  it('settles as ok+branch or a coded refusal — never a bare failure', () => {
    expect(sessionBranchStatePayloadSchema.parse({ ok: true, branch: 'feat/other' })).toEqual({
      ok: true,
      branch: 'feat/other',
    });
    for (const code of BRANCH_SWITCH_FAILURE_CODES) {
      expect(sessionBranchStatePayloadSchema.safeParse({ ok: false, code }).success).toBe(true);
    }
    expect(sessionBranchStatePayloadSchema.safeParse({ ok: false }).success).toBe(false);
    expect(sessionBranchStatePayloadSchema.safeParse({ ok: true }).success).toBe(false);
    expect(sessionBranchStatePayloadSchema.safeParse({ ok: false, code: 'because' }).success).toBe(
      false,
    );
  });
});

/**
 * The `repo.branches` session-scoped variant (T4): with a `sessionId` the daemon lists THAT
 * session's repo and echoes the id so the browser can key the answer to the asking surface.
 * Additive on both sides — the Phase B default-repo form stays byte-identical.
 */
describe('repo.branches sessionId variant', () => {
  const sid = '7c9e6679-7425-40de-963d-2f1b2c8a0f1e';

  it('still accepts the Phase B default form on both sides', () => {
    expect(repoBranchesRequestPayloadSchema.parse({})).toEqual({});
    expect(
      repoBranchesStatePayloadSchema.parse({ available: true, branches: ['main'] }).sessionId,
    ).toBeUndefined();
  });

  it('carries a session-scoped ask and its echoed answer', () => {
    expect(repoBranchesRequestPayloadSchema.parse({ sessionId: sid })).toEqual({ sessionId: sid });
    const state = repoBranchesStatePayloadSchema.parse({
      available: true,
      branches: ['main', 'work'],
      defaultBranch: 'main',
      sessionId: sid,
    });
    expect(state.sessionId).toBe(sid);
  });

  it('rejects a malformed session id on either side', () => {
    expect(repoBranchesRequestPayloadSchema.safeParse({ sessionId: 'nope' }).success).toBe(false);
    expect(
      repoBranchesStatePayloadSchema.safeParse({ available: false, branches: [], sessionId: '..' })
        .success,
    ).toBe(false);
  });
});
