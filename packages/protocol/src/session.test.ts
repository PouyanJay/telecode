import { describe, expect, it } from 'vitest';

import {
  agentPermissionRequestPayloadSchema,
  permissionDecisionPayloadSchema,
  sessionHistoryPayloadSchema,
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
