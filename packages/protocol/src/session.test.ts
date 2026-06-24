import { describe, expect, it } from 'vitest';

import { agentPermissionRequestPayloadSchema, permissionDecisionPayloadSchema } from './session';

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
