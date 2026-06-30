import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { runHookBridge } from './hook-bridge';
import { createHookSocketServer, type HookSocketServer } from './hook-socket';

const logger = pino({ level: 'silent' });

/**
 * The `telecode hook` bridge (Journey 1, Task 7): pipe Claude Code's hook JSON (stdin) → the daemon's Unix
 * socket → the decision (stdout). Verified against the real T4 socket server. FAIL-CLOSED: a missing/dead
 * daemon yields `{}` (no decision) and exit 0 — Claude falls back to its local prompt, never auto-allows.
 */
function collectStdout(): { stream: Writable; text(): string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      text += chunk.toString('utf8');
      cb();
    },
  });
  return { stream, text: () => text };
}

describe('runHookBridge', () => {
  let server: HookSocketServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('forwards the hook event and writes the daemon decision to stdout', async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-bridge-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    let seen: unknown;
    server = createHookSocketServer({
      socketPath,
      logger,
      handle: async (event) => {
        seen = event;
        return { hookSpecificOutput: { permissionDecision: 'allow' } };
      },
    });
    await server.start();

    const event = { hook_event_name: 'PreToolUse', session_id: 'c1', tool_name: 'Read' };
    const out = collectStdout();
    const code = await runHookBridge({
      socketPath,
      input: Readable.from(Buffer.from(JSON.stringify(event))),
      output: out.stream,
    });

    expect(code).toBe(0);
    expect(seen).toMatchObject({ session_id: 'c1', tool_name: 'Read' });
    expect(JSON.parse(out.text())).toEqual({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });

  it('fails closed to `{}` when the daemon socket is unreachable', async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-bridge-'));
    const out = collectStdout();
    const code = await runHookBridge({
      socketPath: join(dir, 'run', 'does-not-exist.sock'),
      input: Readable.from(Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse' }))),
      output: out.stream,
      connectTimeoutMs: 200,
    });

    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual({});
  });
});
