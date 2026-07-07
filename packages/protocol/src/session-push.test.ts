import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES } from './envelope';
import {
  PUSH_FAILURE_CODES,
  sessionPushRequestPayloadSchema,
  sessionPushStatePayloadSchema,
} from './session';

/**
 * `session.push` / `session.push.state` (branch-actions T6): the Open-PR flow's push leg. The
 * daemon pushes with the laptop's own credentials; the reply carries just enough for the BROWSER
 * to build the PR page URL itself — no GitHub token ever leaves the user's browser session.
 */
describe('session.push payloads', () => {
  it('registers both message types', () => {
    expect(MESSAGE_TYPES).toContain('session.push');
    expect(MESSAGE_TYPES).toContain('session.push.state');
  });

  it('accepts the empty push ask (and strips stray keys)', () => {
    expect(sessionPushRequestPayloadSchema.parse({})).toEqual({});
    expect(sessionPushRequestPayloadSchema.parse({ later: true })).toEqual({});
  });

  it('settles as ok (branch + optional base/repo) or a coded refusal', () => {
    expect(
      sessionPushStatePayloadSchema.parse({
        ok: true,
        branch: 'telecode/fix-login-ab12',
        base: 'main',
        githubRepo: 'acme/app',
      }),
    ).toEqual({
      ok: true,
      branch: 'telecode/fix-login-ab12',
      base: 'main',
      githubRepo: 'acme/app',
    });
    expect(sessionPushStatePayloadSchema.parse({ ok: true, branch: 'feat/x' })).toEqual({
      ok: true,
      branch: 'feat/x',
    });
    for (const code of PUSH_FAILURE_CODES) {
      expect(sessionPushStatePayloadSchema.safeParse({ ok: false, code }).success).toBe(true);
    }
  });

  it('rejects a bare success, a codeless refusal, and an unknown code', () => {
    expect(sessionPushStatePayloadSchema.safeParse({ ok: true }).success).toBe(false);
    expect(sessionPushStatePayloadSchema.safeParse({ ok: false }).success).toBe(false);
    expect(sessionPushStatePayloadSchema.safeParse({ ok: false, code: 'because' }).success).toBe(
      false,
    );
  });
});
