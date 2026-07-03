import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

// Capture the options the adapter passes to the SDK's query(), without a real model call. Hoisted so the
// mock factory (itself hoisted above the import) can reach it.
const { queryCalls } = vi.hoisted(() => ({
  queryCalls: [] as { options: Record<string, unknown> }[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-x' };
    })();
  },
}));

import { createClaudeAgentAdapter } from './claude-agent-adapter';

/**
 * The real adapter's SDK wiring (Journey 4): `forkSession` reaches `query()` only when a `resume` is set —
 * so a free-form handover forks the resumed conversation (new id + own transcript), while an ordinary turn
 * never forks. Model call is mocked; this locks the option threading the spike proved live.
 */
describe('createClaudeAgentAdapter: forkSession threading', () => {
  const log = pino({ level: 'silent' });
  const run = (opts: { resume?: string; forkSession?: boolean }) =>
    createClaudeAgentAdapter({ logger: log }).run('go', {
      canUseTool: async () => ({ behavior: 'allow' }),
      onEvent: () => undefined,
      ...opts,
    });

  it('passes forkSession to query() when resuming', async () => {
    await run({ resume: 'r1', forkSession: true });
    const { options } = queryCalls.at(-1)!;
    expect(options.resume).toBe('r1');
    expect(options.forkSession).toBe(true);
  });

  it('drops forkSession when there is no resume (an ordinary first turn never forks)', async () => {
    await run({ forkSession: true });
    const { options } = queryCalls.at(-1)!;
    expect(options.resume).toBeUndefined();
    expect(options.forkSession).toBeUndefined();
  });

  it('omits forkSession on a plain resume', async () => {
    await run({ resume: 'r2' });
    const { options } = queryCalls.at(-1)!;
    expect(options.resume).toBe('r2');
    expect(options.forkSession).toBeUndefined();
  });
});
