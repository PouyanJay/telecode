import { describe, expect, it } from 'vitest';

import {
  agentPermissionRequestPayloadSchema,
  permissionDecisionPayloadSchema,
  sessionControlPayloadSchema,
  sessionHistoryPayloadSchema,
  sessionKeyPayloadSchema,
  sessionLaunchPayloadSchema,
  userMessagePayloadSchema,
} from './session';

/**
 * The human-in-the-loop permission messages (Task 6). `agent.permission_request` (daemon → web) carries
 * a correlated `requestId` plus the tool the agent wants to run; `permission.decision` (web → daemon) is
 * the human's verdict, discriminated on `behavior` (allow / allow-with-edit / deny) and tied back by the
 * same `requestId`.
 */
describe('agentPermissionRequestPayloadSchema', () => {
  it('parses a tool request awaiting a decision', () => {
    const parsed = agentPermissionRequestPayloadSchema.parse({
      requestId: 'req_1',
      toolName: 'Write',
      input: { path: 'README.md', content: 'hi' },
    });
    expect(parsed.toolName).toBe('Write');
    expect(parsed.input).toEqual({ path: 'README.md', content: 'hi' });
  });

  it('rejects a request without a correlation id', () => {
    const result = agentPermissionRequestPayloadSchema.safeParse({
      requestId: '',
      toolName: 'Write',
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a request with no tool name', () => {
    const result = agentPermissionRequestPayloadSchema.safeParse({
      requestId: 'req_1',
      toolName: '',
      input: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('permissionDecisionPayloadSchema', () => {
  it('parses a plain allow', () => {
    const parsed = permissionDecisionPayloadSchema.parse({
      requestId: 'req_1',
      behavior: 'allow',
    });
    expect(parsed.behavior).toBe('allow');
    if (parsed.behavior === 'allow') {
      expect(parsed.updatedInput).toBeUndefined();
    }
  });

  it('parses an allow-with-edit carrying replacement input', () => {
    const parsed = permissionDecisionPayloadSchema.parse({
      requestId: 'req_1',
      behavior: 'allow',
      updatedInput: { path: 'SAFE.md', content: 'edited' },
    });
    if (parsed.behavior !== 'allow') throw new Error('expected allow');
    expect(parsed.updatedInput).toEqual({ path: 'SAFE.md', content: 'edited' });
  });

  it('parses a deny with a human-readable reason', () => {
    const parsed = permissionDecisionPayloadSchema.parse({
      requestId: 'req_1',
      behavior: 'deny',
      message: 'not allowed',
    });
    if (parsed.behavior !== 'deny') throw new Error('expected deny');
    expect(parsed.message).toBe('not allowed');
  });

  it('parses a deny without a reason (message optional)', () => {
    const parsed = permissionDecisionPayloadSchema.parse({ requestId: 'req_1', behavior: 'deny' });
    expect(parsed.behavior).toBe('deny');
  });

  it('rejects an unknown behavior', () => {
    const result = permissionDecisionPayloadSchema.safeParse({
      requestId: 'req_1',
      behavior: 'maybe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a decision without a correlation id', () => {
    const result = permissionDecisionPayloadSchema.safeParse({ behavior: 'allow' });
    expect(result.success).toBe(false);
  });
});

describe('sessionLaunchPayloadSchema: repo selection (Task 8)', () => {
  it('parses a launch carrying a repo to clone on demand', () => {
    const parsed = sessionLaunchPayloadSchema.parse({
      prompt: 'fix the bug',
      repo: {
        owner: 'octocat',
        name: 'hello-world',
        cloneUrl: 'https://github.com/octocat/hello-world.git',
      },
    });
    expect(parsed.repo).toEqual({
      owner: 'octocat',
      name: 'hello-world',
      cloneUrl: 'https://github.com/octocat/hello-world.git',
    });
  });

  it('parses a launch with no repo (repo is optional)', () => {
    const parsed = sessionLaunchPayloadSchema.parse({ prompt: 'just chat' });
    expect(parsed.repo).toBeUndefined();
  });

  it('rejects a repo whose owner/name is not a safe path segment', () => {
    for (const segment of ['..', '.', 'has/slash', 'bad space', '']) {
      expect(
        sessionLaunchPayloadSchema.safeParse({
          prompt: 'x',
          repo: { owner: segment, name: 'ok', cloneUrl: 'https://example.com/r.git' },
        }).success,
        `owner ${JSON.stringify(segment)} must be rejected`,
      ).toBe(false);
      expect(
        sessionLaunchPayloadSchema.safeParse({
          prompt: 'x',
          repo: { owner: 'ok', name: segment, cloneUrl: 'https://example.com/r.git' },
        }).success,
        `name ${JSON.stringify(segment)} must be rejected`,
      ).toBe(false);
    }
  });

  it('rejects a repo with an empty clone url', () => {
    expect(
      sessionLaunchPayloadSchema.safeParse({
        prompt: 'x',
        repo: { owner: 'ok', name: 'ok', cloneUrl: '' },
      }).success,
    ).toBe(false);
  });
});

describe('sessionControlPayloadSchema: per-session controls (Task 9)', () => {
  it('parses each control action', () => {
    for (const action of ['end', 'interrupt'] as const) {
      expect(sessionControlPayloadSchema.parse({ action }).action).toBe(action);
    }
  });

  it('rejects an unknown control action (pause/resume were removed)', () => {
    expect(sessionControlPayloadSchema.safeParse({ action: 'pause' }).success).toBe(false);
    expect(sessionControlPayloadSchema.safeParse({ action: 'resume' }).success).toBe(false);
    expect(sessionControlPayloadSchema.safeParse({ action: 'restart' }).success).toBe(false);
    expect(sessionControlPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('userMessagePayloadSchema', () => {
  it('parses a follow-up instruction', () => {
    expect(userMessagePayloadSchema.parse({ text: 'now add tests' }).text).toBe('now add tests');
  });

  it('rejects an empty follow-up', () => {
    expect(userMessagePayloadSchema.safeParse({ text: '' }).success).toBe(false);
  });
});

describe('sessionHistoryPayloadSchema', () => {
  it('parses a backfilled transcript of mixed entry kinds + status', () => {
    const parsed = sessionHistoryPayloadSchema.parse({
      status: 'awaiting_input',
      entries: [
        { kind: 'user', text: 'do it' },
        { kind: 'message', text: 'working' },
        { kind: 'tool', toolName: 'Read', input: { path: 'README.md' } },
        { kind: 'permission', requestId: 'req_1', toolName: 'Write', input: {}, decision: 'allow' },
      ],
    });
    expect(parsed.status).toBe('awaiting_input');
    expect(parsed.entries).toHaveLength(4);
  });

  it('accepts an empty transcript (a not-live session)', () => {
    expect(
      sessionHistoryPayloadSchema.safeParse({ status: 'offline_paused', entries: [] }).success,
    ).toBe(true);
  });

  it('rejects a permission entry with an unknown decision', () => {
    const result = sessionHistoryPayloadSchema.safeParse({
      status: 'running',
      entries: [
        { kind: 'permission', requestId: 'r', toolName: 'X', input: {}, decision: 'maybe' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with an unknown kind', () => {
    const result = sessionHistoryPayloadSchema.safeParse({
      status: 'running',
      entries: [{ kind: 'diff', text: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('sessionKeyPayloadSchema', () => {
  // A well-formed base64 32-byte content key (43 base64 chars + one `=` pad).
  const VALID_KEY = `${'A'.repeat(43)}=`;

  it('validates the wrapped per-session content key (base64 32-byte key)', () => {
    expect(sessionKeyPayloadSchema.parse({ key: VALID_KEY }).key).toBe(VALID_KEY);
  });

  it('rejects a key that is not a base64 32-byte key', () => {
    for (const bad of ['', 'YmFzZTY0a2V5', `${'A'.repeat(44)}`]) {
      expect(sessionKeyPayloadSchema.safeParse({ key: bad }).success).toBe(false);
    }
  });

  it('rejects a missing key', () => {
    expect(sessionKeyPayloadSchema.safeParse({}).success).toBe(false);
  });
});
