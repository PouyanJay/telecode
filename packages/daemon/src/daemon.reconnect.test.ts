import { randomUUID } from 'node:crypto';

import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Phase 4 Task 2 — daemon auto-reconnect. The daemon dials *out* to the relay; if that link drops
 * (transient network loss, relay restart), it must transparently redial and re-register (`hello`) while
 * keeping its in-memory session state — not exit or go dark. Driven through the real fake-relay WS:
 * drop the connection server-side and assert the daemon dials back and resumes serving.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

/** Streams one message then completes — enough to prove the daemon serves a launch after reconnecting. */
function quickAdapter(prompts: string[]): AgentAdapter {
  return {
    async run(prompt, { onEvent }) {
      prompts.push(prompt);
      onEvent({ type: 'message', text: `ack: ${prompt}` });
      return { intercepted: [], allowed: [], denied: [], sessionId: 'sdk-1' };
    },
  };
}

async function startDaemon(
  userId: string,
  deviceId: string,
  adapter: AgentAdapter,
): Promise<FakeRelay> {
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: adapter,
    logger: silent,
    // Fast, deterministic backoff for tests.
    reconnect: { baseMs: 10, maxMs: 40 },
  });
  daemons.push(daemon);
  await daemon.start();
  return relay;
}

function launch(
  relay: FakeRelay,
  userId: string,
  deviceId: string,
  sessionId: string,
  prompt: string,
): void {
  relay.send(
    makeEnvelope({ type: 'session.launch', userId, deviceId, sessionId, payload: { prompt } }),
  );
}

const ended = (sessionId: string) => (e: Envelope) =>
  e.type === 'session.ended' && e.session_id === sessionId;

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon: auto-reconnect (Phase 4 Task 2)', () => {
  it('redials and re-registers after the relay link drops', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const relay = await startDaemon(userId, deviceId, quickAdapter([]));

    // The relay drops the daemon's connection (transient loss).
    relay.dropConnection();

    // The daemon must dial back and re-register on its own.
    await relay.waitForHello();
  });

  it('keeps serving sessions after a reconnect (state survives the drop)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const prompts: string[] = [];
    const relay = await startDaemon(userId, deviceId, quickAdapter(prompts));

    relay.dropConnection();
    await relay.waitForHello(); // reconnected + re-registered

    // A launch over the re-established channel still runs end-to-end.
    const sid = randomUUID();
    launch(relay, userId, deviceId, sid, 'after reconnect');
    await relay.waitForFrame(ended(sid));
    expect(prompts).toEqual(['after reconnect']);
  });
});
