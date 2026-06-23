import { pino } from 'pino';

import { createClaudeAgentAdapter } from './claude-agent-adapter';

/**
 * Spike 1 (runnable, local — spends API usage): prove the Claude Agent SDK can spawn a headless
 * session and that a tool-permission request is intercepted via `canUseTool` with a programmatic
 * allow/deny. Run from the repo root:
 *
 *   node --import tsx --env-file=.env packages/daemon/src/spike-agent-sdk.ts
 *
 * IMPORTANT — run this OUTSIDE a Claude Code session. When it runs nested inside Claude Code, the
 * SDK routes tool-permission decisions to the PARENT harness instead of this `canUseTool`, so the
 * tool is allowed/denied by the parent and you see `intercepted: 0` regardless of the operation or
 * `settingSources: []`. On a standalone daemon (a user's laptop) `canUseTool` fires normally. A
 * valid `ANTHROPIC_API_KEY` in `.env` is required (and confirmed working).
 *
 * The CI-safe contract test lives in `agent-adapter.test.ts` (no model call) and is the durable
 * Phase 0 proof of the allow/deny contract.
 */
const log = pino({ name: 'spike:agent-sdk', level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error('ANTHROPIC_API_KEY is not set — run with: node --import tsx --env-file=.env ...');
    process.exitCode = 1;
    return;
  }

  const adapter = createClaudeAgentAdapter({
    logger: log,
    model: 'claude-haiku-4-5-20251001',
    allowedTools: ['Write'],
    maxTurns: 3,
  });

  const result = await adapter.run(
    'Use the Write tool to create a file ./telecode-spike-test.txt containing the word telecode. Do nothing else.',
    async (request) => {
      log.info(
        { tool: request.toolName, input: request.input },
        'canUseTool intercepted a tool request — DENYING to prove interception',
      );
      return { behavior: 'deny', message: 'Spike 1: denied by canUseTool.' };
    },
  );

  log.info(
    {
      intercepted: result.intercepted.map((r) => r.toolName),
      allowed: result.allowed,
      denied: result.denied,
    },
    'spike result',
  );

  if (result.intercepted.length === 0) {
    log.warn(
      'canUseTool was not exercised — almost certainly because this ran nested inside Claude Code ' +
        '(the parent harness handles permissions). Re-run standalone, outside any Claude Code session.',
    );
  } else {
    log.info(
      'Spike 1 OK: Agent SDK canUseTool interception demonstrated (allow/deny is programmatic).',
    );
  }
}

main().catch((err: unknown) => {
  log.error({ err }, 'spike failed');
  process.exitCode = 1;
});
