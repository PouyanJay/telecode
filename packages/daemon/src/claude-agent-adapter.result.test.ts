import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

// Scriptable SDK mock: each run consumes the next message script, so one file can exercise every
// terminal `result` subtype. Hoisted so the mock factory (itself hoisted above the import) can reach it.
const { scripts } = vi.hoisted(() => ({ scripts: [] as unknown[][] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const script = scripts.shift() ?? [];
    return (async function* () {
      for (const message of script) yield message;
    })();
  },
}));

import { createClaudeAgentAdapter } from './claude-agent-adapter';

/**
 * Status split (session-identity T2): the SDK's terminal `result` message is the only place a
 * turn-limit ending is distinguishable from a clean completion — the message iterator just ends either
 * way. The adapter must surface its subtype as {@link AgentRunResult.endReason} so the daemon can
 * report "Ended — turn limit" instead of a dishonest "done".
 */
describe('createClaudeAgentAdapter: terminal result capture', () => {
  const log = pino({ level: 'silent' });
  const run = (script: unknown[]) => {
    scripts.push(script);
    return createClaudeAgentAdapter({ logger: log }).run('go', {
      canUseTool: async () => ({ behavior: 'allow' }),
      onEvent: () => undefined,
    });
  };
  const init = { type: 'system', subtype: 'init', session_id: 'sdk-r' };

  it('maps a success result to endReason "completed"', async () => {
    const result = await run([init, { type: 'result', subtype: 'success' }]);
    expect(result.endReason).toBe('completed');
    expect(result.sessionId).toBe('sdk-r');
  });

  it('maps error_max_turns to endReason "turn_limit"', async () => {
    const result = await run([init, { type: 'result', subtype: 'error_max_turns' }]);
    expect(result.endReason).toBe('turn_limit');
  });

  it('maps error_during_execution to endReason "execution_error"', async () => {
    const result = await run([init, { type: 'result', subtype: 'error_during_execution' }]);
    expect(result.endReason).toBe('execution_error');
  });

  it('reports no endReason when the stream ends without a result message (abort / old SDK)', async () => {
    const result = await run([init]);
    expect(result.endReason).toBeUndefined();
  });
});
