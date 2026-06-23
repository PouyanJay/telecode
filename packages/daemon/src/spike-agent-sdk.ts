import { pino } from 'pino';

import { createClaudeAgentAdapter } from './claude-agent-adapter';

/**
 * Spike 1 (runnable, local — spends API usage): prove the Claude Agent SDK can spawn a headless
 * session and that a tool-permission request is intercepted via `canUseTool` with a programmatic
 * allow/deny. Run from the repo root:
 *
 *   node --import tsx --env-file=.env packages/daemon/src/spike-agent-sdk.ts
 *
 * IMPORTANT — two requirements for `canUseTool` to actually fire:
 *  1. A VALID `ANTHROPIC_API_KEY` (or working Claude Code auth).
 *  2. Run it OUTSIDE a Claude Code session. When this runs nested inside Claude Code, the SDK
 *     inherits the parent's permission context and auto-allows tools, bypassing `canUseTool`
 *     (you'll see the tool execute with `intercepted: 0`). `settingSources: []` isolates settings
 *     but cannot undo a nested launch. On a standalone daemon (a user's laptop) this is moot.
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

  const adapter = createClaudeAgentAdapter({ logger: log, allowedTools: ['Bash'], maxTurns: 3 });

  const result = await adapter.run(
    'Use the Bash tool to run exactly: echo telecode. Then stop.',
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
      'canUseTool was not exercised. Likely causes: invalid ANTHROPIC_API_KEY (auth fell back / failed), ' +
        'or running nested inside Claude Code (parent auto-allows tools). Run standalone with a valid key.',
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
