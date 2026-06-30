import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { type HookEvent } from './hook-event';
import { createHookSocketServer, type HookSocketServer } from './hook-socket';

const logger = pino({ level: 'silent' });

/**
 * The hook IPC transport (Journey 1, Task 4): a same-uid Unix domain socket the `telecode hook` bridge
 * connects to. The bridge writes one hook-event JSON and half-closes; the server parses it, runs the
 * injected handler, and writes the handler's response back. No TCP port — preserving the outbound-only
 * invariant. The socket file is `0600` (owner-only).
 */

/** One request/response round-trip over the socket, mirroring how the bridge talks to the daemon. */
function rpc(socketPath: string, request: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let out = '';
    client.on('connect', () => client.end(JSON.stringify(request)));
    client.on('data', (chunk) => {
      out += chunk.toString();
    });
    client.on('end', () => resolve(out));
    client.on('error', reject);
  });
}

const validEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'claude-abc',
  transcript_path: '/x/y.jsonl',
  cwd: '/repo',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'toolu_1',
};

describe('createHookSocketServer', () => {
  let server: HookSocketServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function startWith(handle: (event: HookEvent) => Promise<unknown>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'telecode-hooksock-'));
    const socketPath = join(dir, 'run', 'hook.sock');
    server = createHookSocketServer({ socketPath, handle, logger });
    await server.start();
    return socketPath;
  }

  it('parses a hook event, runs the handler, and returns its response', async () => {
    let received: HookEvent | undefined;
    const socketPath = await startWith(async (event) => {
      received = event;
      return { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } };
    });

    const response = await rpc(socketPath, validEvent);

    expect(received?.session_id).toBe('claude-abc');
    expect(received?.tool_use_id).toBe('toolu_1');
    expect(JSON.parse(response)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('creates the socket file owner-only (0600)', async () => {
    const socketPath = await startWith(async () => ({}));
    const mode = (await stat(socketPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('drops a malformed event without calling the handler (fail-closed empty response)', async () => {
    let called = false;
    const socketPath = await startWith(async () => {
      called = true;
      return { ok: true };
    });

    const response = await rpc(socketPath, { not: 'a hook event' });

    expect(called).toBe(false);
    expect(JSON.parse(response)).toEqual({});
  });

  it('returns an empty (no-decision) response when the handler throws', async () => {
    const socketPath = await startWith(async () => {
      throw new Error('boom');
    });
    expect(JSON.parse(await rpc(socketPath, validEvent))).toEqual({});
  });

  it('removes the socket file on stop', async () => {
    const socketPath = await startWith(async () => ({}));
    await server!.stop();
    server = undefined;
    await expect(stat(socketPath)).rejects.toThrow();
  });
});
