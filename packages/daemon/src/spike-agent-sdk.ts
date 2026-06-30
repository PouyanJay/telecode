import { pino } from 'pino';

import { createClaudeAgentAdapter } from './claude-agent-adapter';

/**
 * Real-SDK gate verification (runnable, local — spends API usage). This is the probe the unit/integration
 * suites can't be: it runs the ACTUAL Claude Agent SDK and proves telecode's approval gate (architecture
 * invariant #4) holds against the SDK's real permission engine. Run from the repo root:
 *
 *   node --import tsx --env-file=.env packages/daemon/src/spike-agent-sdk.ts
 *
 * What it proves, in the SDK's `default` mode (the mode that previously let "safe" commands run ungated):
 *  - A "safe" Bash command is STILL routed through `canUseTool` — because the adapter's `PreToolUse` hook
 *    forces every consequential tool to `ask`, defeating the SDK classifier's silent auto-allow. This is
 *    the fix: before it, the SDK auto-ran such commands without ever calling `canUseTool`.
 *  - A read-only tool (Read/Glob/Grep) auto-approves via the same hook, so it does NOT hit `canUseTool`.
 *
 * IMPORTANT — run this OUTSIDE a Claude Code session. Nested inside Claude Code, the SDK routes
 * tool-permission decisions to the PARENT harness instead of this `canUseTool`/hook, so you see
 * `intercepted: 0` regardless. On a standalone daemon (a user's laptop) the gate fires normally. A valid
 * `ANTHROPIC_API_KEY` in `.env` is required. The CI-safe contract tests are `permission-policy.test.ts`
 * (the pure policy) and `daemon.permission.test.ts` (the daemon wiring), with no model call.
 */
const log = pino({ name: 'verify:gate', level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error('ANTHROPIC_API_KEY is not set — run with: node --import tsx --env-file=.env ...');
    process.exitCode = 1;
    return;
  }

  // No permissionMode → the conservative `default` mode, exactly as a real session runs it.
  const adapter = createClaudeAgentAdapter({
    logger: log,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 3,
  });

  const result = await adapter.run(
    'Run the bash command `pwd` to print the working directory, then use the Read tool to read ./README.md. Do nothing else.',
    {
      canUseTool: async (request) => {
        log.info(
          { tool: request.toolName, input: request.input },
          'canUseTool intercepted a tool — DENYING to prove the gate holds',
        );
        return { behavior: 'deny', message: 'verify-gate: denied to prove interception.' };
      },
      onEvent: (event) => log.info({ event }, 'agent event'),
    },
  );

  const interceptedTools = result.intercepted.map((r) => r.toolName);
  log.info(
    { interceptedTools, allowed: result.allowed, denied: result.denied },
    'verify-gate result',
  );

  if (interceptedTools.length === 0) {
    log.warn(
      'canUseTool was not exercised — almost certainly because this ran nested inside Claude Code ' +
        '(the parent harness handles permissions). Re-run standalone, outside any Claude Code session.',
    );
    return;
  }
  if (interceptedTools.includes('Bash')) {
    log.info(
      'PASS: a "safe" Bash command was routed through canUseTool — the approval gate holds (fix verified).',
    );
  } else {
    log.error(
      'FAIL: Bash was NOT intercepted — the SDK auto-ran it. The approval gate is bypassed (invariant #4).',
    );
    process.exitCode = 1;
  }
  if (interceptedTools.includes('Read')) {
    log.warn(
      'NOTE: Read was intercepted — expected the PreToolUse policy to auto-approve read-only tools.',
    );
  }
}

main().catch((err: unknown) => {
  log.error({ err }, 'verify-gate failed');
  process.exitCode = 1;
});
