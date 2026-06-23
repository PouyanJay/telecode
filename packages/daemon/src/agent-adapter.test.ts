import { describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type CanUseTool } from './agent-adapter';

describe('AgentAdapter permission interception (canUseTool)', () => {
  it('routes every tool request through canUseTool and honors allow/deny', async () => {
    const adapter = createFakeAgentAdapter([
      { toolName: 'Read', input: { path: 'README.md' } },
      { toolName: 'Bash', input: { command: 'rm -rf /' } },
    ]);

    const policy: CanUseTool = async (request) =>
      request.toolName === 'Bash'
        ? { behavior: 'deny', message: 'destructive command blocked' }
        : { behavior: 'allow' };

    const result = await adapter.run('do some work', policy);

    expect(result.intercepted.map((r) => r.toolName)).toEqual(['Read', 'Bash']);
    expect(result.allowed).toEqual(['Read']);
    expect(result.denied).toEqual(['Bash']);
  });

  it('passes the tool input through to the decision function', async () => {
    const seen: Record<string, unknown>[] = [];
    const adapter = createFakeAgentAdapter([{ toolName: 'Bash', input: { command: 'echo hi' } }]);

    await adapter.run('x', async (request) => {
      seen.push(request.input);
      return { behavior: 'deny', message: 'no' };
    });

    expect(seen).toEqual([{ command: 'echo hi' }]);
  });
});
