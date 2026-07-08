import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

// Scriptable SDK mock: each run consumes the next message script, so one file can exercise every
// terminal `result` subtype. Hoisted so the mock factory (itself hoisted above the import) can reach it.
const { scripts } = vi.hoisted(() => ({ scripts: [] as unknown[][] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const script = scripts.shift() ?? [];
    return (async function* () {
      for (const message of script) {
        // A `{ __throw }` script item makes the stream THROW mid-iteration — how some SDK versions
        // surface terminal errors (notably the turn cap) instead of yielding a `result` message.
        if (typeof message === 'object' && message !== null && '__throw' in message) {
          throw message.__throw;
        }
        yield message;
      }
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

  it('captures the model from the SDK init message (ux Phase 6 T5)', async () => {
    const result = await run([
      { type: 'system', subtype: 'init', session_id: 'sdk-r', model: 'claude-sonnet-5' },
      { type: 'result', subtype: 'success' },
    ]);
    expect(result.model).toBe('claude-sonnet-5');
  });

  it('reports no model when the init carries none', async () => {
    const result = await run([init, { type: 'result', subtype: 'success' }]);
    expect(result.model).toBeUndefined();
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

  it('recovers a THROWN turn-cap error as endReason "turn_limit", keeping the conversation id', async () => {
    // Some SDK versions THROW on the cap instead of yielding `result: error_max_turns` — seen live:
    // "Claude Code returned an error result: Reached maximum number of turns (4)". Surfacing that as
    // a run failure turned the designed, followable "ENDED · TURN LIMIT" into FAILED — and, during a
    // fork-resume, misfired the context-losing fresh-launch fallback.
    const result = await run([
      init,
      {
        __throw: new Error(
          'Claude Code returned an error result: Reached maximum number of turns (4)',
        ),
      },
    ]);
    expect(result.endReason).toBe('turn_limit');
    expect(result.sessionId).toBe('sdk-r');
  });

  it('attaches the started conversation to a genuine mid-stream failure (AgentRunError)', async () => {
    // The daemon needs to know a throwing run had already STARTED its conversation: the resume
    // fallback must not fire (it would lose the started context), and the captured id lets a
    // follow-up resume instead of dead-ending in needs_restart.
    const failure = run([init, { __throw: new Error('api exploded') }]);
    await expect(failure).rejects.toMatchObject({
      name: 'AgentRunError',
      message: 'api exploded',
      hasConversationStarted: true,
      sessionId: 'sdk-r',
    });
  });

  it('marks a failure BEFORE the init as conversation-not-started (a true resume failure)', async () => {
    const failure = run([{ __throw: new Error('No conversation found with session ID: x') }]);
    await expect(failure).rejects.toMatchObject({
      name: 'AgentRunError',
      hasConversationStarted: false,
    });
  });
});
