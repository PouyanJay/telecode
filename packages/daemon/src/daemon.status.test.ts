import { randomUUID } from 'node:crypto';

import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeAgentAdapter, type AgentAdapter } from './agent-adapter';
import { createDaemon, type Daemon } from './daemon';
import { startFakeRelay, type FakeRelay } from './fake-relay';

/**
 * Status split (session-identity T2), daemon leg. A turn that exhausted its budget must end as
 * `turn_limit` — cleartext envelope status for the relay's registry AND in the payload for the web —
 * and the session must stay followable: the next user.message resumes the same conversation. An
 * SDK-internal soft failure (`execution_error`) ends as `error`, never a dishonest `done`.
 */
const silent = pino({ level: 'silent' });
const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];

const ofType = (type: string, sessionId: string) => (e: Envelope) =>
  e.type === type && e.session_id === sessionId;

async function startDaemon(adapter: AgentAdapter): Promise<{
  relay: FakeRelay;
  userId: string;
  deviceId: string;
}> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const relay = await startFakeRelay(userId, deviceId);
  relays.push(relay);
  const daemon = createDaemon({
    relayUrl: relay.url,
    userId,
    deviceId,
    agentAdapter: adapter,
    logger: silent,
  });
  daemons.push(daemon);
  await daemon.start();
  return { relay, userId, deviceId };
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe('daemon status split (session-identity T2)', () => {
  it('ends a turn-limited run as turn_limit (cleartext status + payload)', async () => {
    const { relay, userId, deviceId } = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'partial work' }], {
        sessionId: 'sdk-tl',
        endReason: 'turn_limit',
      }),
    );
    const sessionId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'a long task' },
      }),
    );

    const ended = await relay.waitForFrame(ofType('session.ended', sessionId));
    expect(ended.status).toBe('turn_limit');
    expect(ended.payload).toMatchObject({ status: 'turn_limit' });
  });

  it('never adds turn_limit to endedSessions: a follow-up is accepted and resumes the conversation', async () => {
    const resumes: (string | undefined)[] = [];
    const { relay, userId, deviceId } = await startDaemon(
      createFakeAgentAdapter([{ type: 'message', text: 'continuing' }], {
        sessionId: 'sdk-tl2',
        endReason: 'turn_limit',
        onRun: ({ resume }) => resumes.push(resume),
      }),
    );
    const sessionId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'first turn' },
      }),
    );
    await relay.waitForFrame(ofType('session.ended', sessionId));

    relay.send(
      makeEnvelope({
        type: 'user.message',
        userId,
        deviceId,
        sessionId,
        payload: { text: 'keep going' },
      }),
    );
    const ended2 = await relay.waitForFrame(ofType('session.ended', sessionId));
    expect(ended2.status).toBe('turn_limit');
    // The follow-up resumed the SAME conversation — turn_limit is a pause, not a death.
    expect(resumes).toEqual([undefined, 'sdk-tl2']);
  });

  it('lets an interrupt win over a raced endReason (the adapter settled turn_limit as the abort landed)', async () => {
    // The adapter resolves — normally, with a captured endReason — only once its abort signal fires,
    // reproducing the race where the SDK reports error_max_turns in the same instant the operator
    // interrupts. The interrupt is the operator's explicit action: the turn must end `done`.
    const racingAdapter: AgentAdapter = {
      run: (_prompt, { signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () =>
            resolve({
              intercepted: [],
              allowed: [],
              denied: [],
              sessionId: 'sdk-race',
              endReason: 'turn_limit',
            }),
          );
        }),
    };
    const { relay, userId, deviceId } = await startDaemon(racingAdapter);
    const sessionId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'about to be interrupted' },
      }),
    );
    await relay.waitForFrame(ofType('session.started', sessionId));

    relay.send(
      makeEnvelope({
        type: 'session.control',
        userId,
        deviceId,
        sessionId,
        payload: { action: 'interrupt' },
      }),
    );
    const ended = await relay.waitForFrame(ofType('session.ended', sessionId));
    expect(ended.status).toBe('done');
  });

  it('ends an SDK-internal soft failure as error, not done', async () => {
    const { relay, userId, deviceId } = await startDaemon(
      createFakeAgentAdapter([], { sessionId: 'sdk-ee', endReason: 'execution_error' }),
    );
    const sessionId = randomUUID();
    relay.send(
      makeEnvelope({
        type: 'session.launch',
        userId,
        deviceId,
        sessionId,
        payload: { prompt: 'will soft-fail' },
      }),
    );

    const ended = await relay.waitForFrame(ofType('session.ended', sessionId));
    expect(ended.status).toBe('error');
    expect(ended.payload).toMatchObject({ status: 'error' });
  });
});
