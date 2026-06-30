import { makeEnvelope, type SessionLaunchPayload } from '@telecode/protocol';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RelayConnection, type RelayConnectionOptions } from './relay-client';
import { answer, connect, disconnect, launch, sessions } from './session-store';

/**
 * Phase 2 Task 11 — the launch-correlation + timeout edges deferred from Task 5 (AD-P2-9). The relay
 * mints the session id, so `launch()` puts a `clientRef` nonce on the launch and resolves when
 * `session.started` echoes it. Matching by the nonce (not arrival order) means a late frame for a
 * timed-out launch can never mis-resolve a later one. Driven through a fake connection (the `connect`
 * seam), with fake timers for the 15s launch timeout.
 */
const userId = 'user-1';
const deviceId = 'device-1';

/** A fake relay connection that records launch/subscribe calls and lets the test emit inbound frames. */
function makeFakeConnection() {
  const launched: SessionLaunchPayload[] = [];
  const subscribed: string[] = [];
  const answered: { sessionId: string; payload: unknown }[] = [];
  let emit: (envelope: ReturnType<typeof makeEnvelope>) => void = () => undefined;
  let fireReconnect: () => void = () => undefined;
  const create = (options: RelayConnectionOptions): RelayConnection => {
    emit = options.onEvent;
    fireReconnect = () => options.onReconnect?.();
    options.onStatus('connected');
    return {
      launch: (payload) => launched.push(payload),
      subscribe: (id) => subscribed.push(id),
      sendUserMessage: () => undefined,
      decide: () => undefined,
      answer: (sessionId, payload) => answered.push({ sessionId, payload }),
      control: () => undefined,
      close: () => undefined,
    };
  };
  return {
    create,
    launched,
    subscribed,
    answered,
    /** Simulate the daemon raising an adopted-session question on a session. */
    question(sessionId: string, requestId: string) {
      emit(
        makeEnvelope({
          type: 'agent.question',
          userId,
          deviceId,
          sessionId,
          payload: {
            requestId,
            questions: [
              {
                question: 'Which DB?',
                header: 'DB',
                multiSelect: false,
                options: [{ label: 'Postgres' }],
              },
            ],
          },
        }),
      );
    },
    /** Simulate the connection re-authenticating after a dropped socket (browser auto-reconnect). */
    reconnect() {
      fireReconnect();
    },
    /** Simulate the relay's device.presence frame (daemon behind the channel connected/disconnected). */
    presence(online: boolean) {
      emit(makeEnvelope({ type: 'device.presence', userId, deviceId, payload: { online } }));
    },
    /** Simulate the daemon's `session.started` echoing a clientRef for a minted session id. */
    started(sessionId: string, clientRef?: string) {
      emit(
        makeEnvelope({
          type: 'session.started',
          userId,
          deviceId,
          sessionId,
          payload: clientRef !== undefined ? { clientRef } : {},
        }),
      );
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  disconnect();
  vi.useRealTimers();
});

describe('session-store launch correlation (Task 11)', () => {
  it('resolves launch() with the minted id when session.started echoes its clientRef', async () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    const pending = launch({ prompt: 'do it' });
    const clientRef = fake.launched[0]?.clientRef;
    expect(clientRef).toBeDefined();

    fake.started('session-abc', clientRef);
    await expect(pending).resolves.toBe('session-abc');
  });

  it('rejects launch() on timeout when no session.started arrives', async () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    const pending = launch({ prompt: 'offline device' });
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('re-subscribes every known session after a reconnect so the daemon backfills (Phase 4 T1)', () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    // Two sessions are live in this browser (seeded via inbound frames).
    fake.started('sess-1');
    fake.started('sess-2');

    // The socket drops and the client transparently re-authenticates → the store reattaches every known
    // session (reopen = reconnect, invariant #7) so the daemon backfills their current transcripts.
    fake.reconnect();
    expect(fake.subscribed).toEqual(['sess-1', 'sess-2']);
  });

  it('pauses live sessions when the device goes offline, resumes them when it returns (Phase 4 T3)', () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    fake.started('sess-1');
    fake.started('sess-2');

    // The daemon behind the channel drops: the relay signals offline → live sessions pause.
    fake.presence(false);
    const paused = get(sessions);
    expect(paused.get('sess-1')?.status).toBe('offline_paused');
    expect(paused.get('sess-2')?.status).toBe('offline_paused');

    // The daemon reconnects: the relay signals online → the store resubscribes to resume (backfill).
    fake.presence(true);
    expect(fake.subscribed).toEqual(['sess-1', 'sess-2']);
  });

  it('marks a question answer in-flight and sends it to the relay (Journey 2)', () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    fake.started('sess-q');
    fake.question('sess-q', 'q1');

    answer('sess-q', { requestId: 'q1', answers: [{ selectedLabels: ['Postgres'] }] });

    // Marked in-flight locally (answering, verification-gated) and forwarded to the relay.
    const entry = get(sessions)
      .get('sess-q')
      ?.entries.find((e) => e.kind === 'question');
    expect(entry?.kind === 'question' && entry.answer).toBe('answering');
    expect(fake.answered).toEqual([
      {
        sessionId: 'sess-q',
        payload: { requestId: 'q1', answers: [{ selectedLabels: ['Postgres'] }] },
      },
    ]);
  });

  it('a late frame for a timed-out launch never mis-resolves a later launch', async () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    // Launch A times out (its clientRef is now stale).
    const launchA = launch({ prompt: 'A' });
    const refA = fake.launched[0]!.clientRef!;
    const rejectedA = expect(launchA).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejectedA;

    // Launch B is now pending.
    const launchB = launch({ prompt: 'B' });
    const refB = fake.launched[1]!.clientRef!;
    expect(refB).not.toBe(refA);

    // A late session.started carrying A's stale ref must NOT resolve B.
    fake.started('session-A-late', refA);
    // B resolves only to ITS own started frame.
    fake.started('session-B', refB);
    await expect(launchB).resolves.toBe('session-B');
  });
});
