import { describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentEvent, type CanUseTool } from './agent-adapter';

describe('AgentAdapter: streaming + permission interception (canUseTool)', () => {
  it('streams messages, gates tool_use through canUseTool, and honors allow/deny', async () => {
    const adapter = createFakeAgentAdapter([
      { type: 'message', text: 'starting' },
      { type: 'tool_use', toolName: 'Read', input: { path: 'README.md' } },
      { type: 'tool_use', toolName: 'Bash', input: { command: 'rm -rf /' } },
      { type: 'message', text: 'done' },
    ]);

    const policy: CanUseTool = async (request) =>
      request.toolName === 'Bash'
        ? { behavior: 'deny', message: 'destructive command blocked' }
        : { behavior: 'allow' };

    const events: AgentEvent[] = [];
    const result = await adapter.run('do some work', {
      canUseTool: policy,
      onEvent: (event) => events.push(event),
    });

    expect(result.intercepted.map((r) => r.toolName)).toEqual(['Read', 'Bash']);
    expect(result.allowed).toEqual(['Read']);
    expect(result.denied).toEqual(['Bash']);
    // Both messages stream, plus the allowed tool_use — but never the denied Bash.
    expect(events).toEqual([
      { type: 'message', text: 'starting' },
      { type: 'tool_use', toolName: 'Read', input: { path: 'README.md' } },
      { type: 'message', text: 'done' },
    ]);
  });

  it('passes the tool input through to the decision function', async () => {
    const seen: Record<string, unknown>[] = [];
    const adapter = createFakeAgentAdapter([
      { type: 'tool_use', toolName: 'Bash', input: { command: 'echo hi' } },
    ]);

    await adapter.run('x', {
      canUseTool: async (request) => {
        seen.push(request.input);
        return { behavior: 'deny', message: 'no' };
      },
      onEvent: () => undefined,
    });

    expect(seen).toEqual([{ command: 'echo hi' }]);
  });
});
