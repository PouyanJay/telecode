import {
  makeEnvelope,
  type AdoptStatePayload,
  type Envelope,
  type WorkspaceReapStatePayload,
} from '@telecode/protocol';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RelayConnection, type RelayConnectionOptions } from './relay-client';
import {
  adoptStates,
  connectDevices,
  connectionState,
  decide,
  deviceChannels,
  disconnect,
  ensureConnections,
  launch,
  pushSessionBranch,
  reapWorkspace,
  requestAdoptConfig,
  seedSessionDevices,
  sendUserMessage,
  sessionDevices,
  sessions,
  setAdoptConfig,
  subscribe,
  switchSessionBranch,
} from './session-store';

/**
 * Multi-device (ux Phase 5) walking skeleton: the store holds one relay connection PER paired
 * device — every device's frames demultiplex into the one session map, per-session routing is
 * recorded from the envelopes' device_id (and registry seeds), presence is per device, and sends
 * go out on the session's OWN device's connection. The single-device store was the degenerate
 * case of this pool.
 */
const userId = 'user-1';
const DEVICE_A = { id: 'device-a', publicKey: 'pk-a' };
const DEVICE_B = { id: 'device-b', publicKey: null };

interface FakeConn {
  readonly options: RelayConnectionOptions;
  readonly subscribed: string[];
  readonly decisions: { sessionId: string; payload: unknown }[];
  readonly messages: { sessionId: string; text: string }[];
  readonly launched: unknown[];
  readonly adoptConfigs: unknown[];
  readonly reaps: string[];
  readonly switches: { sessionId: string; branch: string }[];
  readonly pushes: string[];
  closed: boolean;
  emit(envelope: Envelope): void;
  emitAdoptState(state: AdoptStatePayload): void;
  emitWorkspaceReap(state: WorkspaceReapStatePayload): void;
  setStatus(status: 'connecting' | 'connected' | 'error'): void;
  reconnect(): void;
}

/** A pool-aware fake factory: records one controllable connection per createConn call. */
function makeFakePool() {
  const byDevice = new Map<string, FakeConn>();
  const create = (options: RelayConnectionOptions): RelayConnection => {
    const conn: FakeConn = {
      options,
      subscribed: [],
      decisions: [],
      messages: [],
      launched: [],
      adoptConfigs: [],
      reaps: [],
      switches: [],
      pushes: [],
      closed: false,
      emit: (envelope) => options.onEvent(envelope),
      emitAdoptState: (state) => options.onAdoptState?.(state),
      emitWorkspaceReap: (state) => options.onWorkspaceReap?.(state),
      setStatus: (status) => options.onStatus(status),
      reconnect: () => options.onReconnect?.(),
    };
    byDevice.set(options.deviceId, conn);
    options.onStatus('connected');
    return {
      launch: (payload) => conn.launched.push(payload),
      subscribe: (id) => conn.subscribed.push(id),
      sendUserMessage: (sessionId, text) => conn.messages.push({ sessionId, text }),
      decide: (sessionId, payload) => conn.decisions.push({ sessionId, payload }),
      answer: () => undefined,
      answerHandover: () => undefined,
      control: () => undefined,
      resumeNew: () => undefined,
      sealTitle: async () => ({ payload: 'sealed-title', nonce: 'nonce' }),
      sendRepoBranchesRequest: () => undefined,
      sendWorkspaceReap: (sessionId) => conn.reaps.push(sessionId),
      switchBranch: (sessionId, branch) => conn.switches.push({ sessionId, branch }),
      pushBranch: (sessionId) => conn.pushes.push(sessionId),
      sendAdoptConfig: (set) => conn.adoptConfigs.push(set),
      close: () => {
        conn.closed = true;
      },
    };
  };
  return { create, byDevice };
}

function frame(deviceId: string, type: 'session.started' | 'agent.message', sessionId: string) {
  return makeEnvelope({
    type,
    userId,
    deviceId,
    sessionId,
    payload: type === 'session.started' ? {} : { text: 'hi' },
  });
}

function presence(deviceId: string, online: boolean) {
  return makeEnvelope({ type: 'device.presence', userId, deviceId, payload: { online } });
}

const options = {
  relayUrl: 'ws://x',
  userId,
  getChannelToken: () => Promise.resolve('t'),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  disconnect();
  vi.useRealTimers();
});

describe('multi-device connection pool (ux Phase 5 T1)', () => {
  it('opens one connection per paired device, each with its own identity and key', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    expect([...pool.byDevice.keys()]).toEqual(['device-a', 'device-b']);
    expect(pool.byDevice.get('device-a')?.options.daemonPublicKey).toBe('pk-a');
    expect(pool.byDevice.get('device-b')?.options.daemonPublicKey).toBeNull();
    expect(pool.byDevice.get('device-b')?.options.userId).toBe(userId);
  });

  it('is idempotent per device and closes the connection of a device no longer paired', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    const first = pool.byDevice.get('device-a');

    // Re-running with the same fleet opens nothing new; the pooled connections are reused.
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    expect(pool.byDevice.get('device-a')).toBe(first);

    // Device B was revoked: its connection closes and its channel state drops.
    connectDevices([DEVICE_A], options, pool.create);
    expect(pool.byDevice.get('device-b')?.closed).toBe(true);
    expect(get(deviceChannels).has('device-b')).toBe(false);
    expect(get(deviceChannels).has('device-a')).toBe(true);
  });

  it('demultiplexes frames from every device into ONE session map and records routing', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    pool.byDevice.get('device-a')!.emit(frame('device-a', 'session.started', 'sess-a'));
    pool.byDevice.get('device-b')!.emit(frame('device-b', 'session.started', 'sess-b'));

    const map = get(sessions);
    expect(map.has('sess-a')).toBe(true);
    expect(map.has('sess-b')).toBe(true);
    expect(get(sessionDevices).get('sess-a')).toBe('device-a');
    expect(get(sessionDevices).get('sess-b')).toBe('device-b');
  });

  it('tracks presence per device and pauses only the offline device’s sessions', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    pool.byDevice.get('device-a')!.emit(frame('device-a', 'session.started', 'sess-a'));
    pool.byDevice.get('device-b')!.emit(frame('device-b', 'session.started', 'sess-b'));

    pool.byDevice.get('device-a')!.emit(presence('device-a', true));
    pool.byDevice.get('device-b')!.emit(presence('device-b', false));

    const channels = get(deviceChannels);
    expect(channels.get('device-a')?.daemonOnline).toBe(true);
    expect(channels.get('device-b')?.daemonOnline).toBe(false);

    // Device B going offline pauses ITS session only — device A's stays live.
    const map = get(sessions);
    expect(map.get('sess-b')?.status).toBe('offline_paused');
    expect(map.get('sess-a')?.status).not.toBe('offline_paused');
  });

  it('aggregates the connection state across the pool for the system bar', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    expect(get(connectionState)).toBe('connected');

    // One socket erroring while another is live keeps the aggregate honest at connected.
    pool.byDevice.get('device-b')!.setStatus('error');
    expect(get(connectionState)).toBe('connected');

    // Every socket down → the aggregate degrades to the worst shared truth.
    pool.byDevice.get('device-a')!.setStatus('error');
    expect(get(connectionState)).toBe('error');
  });

  it('routes a decision to the session’s OWN device, never another channel', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    pool.byDevice.get('device-b')!.emit(frame('device-b', 'session.started', 'sess-b'));

    decide('sess-b', { requestId: 'r1', behavior: 'allow' });

    expect(pool.byDevice.get('device-b')?.decisions).toEqual([
      { sessionId: 'sess-b', payload: { requestId: 'r1', behavior: 'allow' } },
    ]);
    expect(pool.byDevice.get('device-a')?.decisions).toEqual([]);
  });

  it('routes a subscribe for a registry-seeded session before any live frame arrived', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    // Cold load: the layout seeds routing from the persisted registry (no frames yet).
    seedSessionDevices([{ id: 'sess-cold', deviceId: 'device-b' }]);
    subscribe('sess-cold');

    expect(pool.byDevice.get('device-b')?.subscribed).toEqual(['sess-cold']);
    expect(pool.byDevice.get('device-a')?.subscribed).toEqual([]);
  });

  it('launches on the explicitly targeted device and resolves on its started echo', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    const pending = launch({ prompt: 'go' }, 'device-b');
    const sent = pool.byDevice.get('device-b')?.launched[0] as { clientRef?: string };
    expect(sent?.clientRef).toBeDefined();
    expect(pool.byDevice.get('device-a')?.launched).toEqual([]);

    pool.byDevice.get('device-b')!.emit(
      makeEnvelope({
        type: 'session.started',
        userId,
        deviceId: 'device-b',
        sessionId: 'sess-new',
        payload: { clientRef: sent.clientRef },
      }),
    );
    await expect(pending).resolves.toBe('sess-new');
    // The launch's own started frame routed the new session to its device.
    expect(get(sessionDevices).get('sess-new')).toBe('device-b');
  });

  it('rejects a launch with no target while several devices are pooled (no guessing)', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    await expect(launch({ prompt: 'where?' })).rejects.toThrow();
    expect(pool.byDevice.get('device-a')?.launched).toEqual([]);
    expect(pool.byDevice.get('device-b')?.launched).toEqual([]);
  });

  it('drops an unrouted send when several devices are pooled — never misroutes (AD-2)', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    // No registry seed, no live frame: the session's device is unknown. A decision must not be
    // guessed onto some channel (the wrong daemon would drop it while the real gate still pends).
    decide('sess-mystery', { requestId: 'r1', behavior: 'allow' });
    subscribe('sess-mystery');

    for (const conn of pool.byDevice.values()) {
      expect(conn.decisions).toEqual([]);
      expect(conn.subscribed).toEqual([]);
    }
  });

  it('reattaches only the reconnected device’s sessions after ITS socket redials', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    pool.byDevice.get('device-a')!.emit(frame('device-a', 'session.started', 'sess-a'));
    pool.byDevice.get('device-b')!.emit(frame('device-b', 'session.started', 'sess-b1'));
    pool.byDevice.get('device-b')!.emit(frame('device-b', 'session.started', 'sess-b2'));

    pool.byDevice.get('device-b')!.reconnect();

    expect(pool.byDevice.get('device-b')?.subscribed).toEqual(['sess-b1', 'sess-b2']);
    expect(pool.byDevice.get('device-a')?.subscribed).toEqual([]);
  });

  it('routes a follow-up message on the session’s own channel and echoes it locally', () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    pool.byDevice.get('device-b')!.emit(frame('device-b', 'session.started', 'sess-b'));

    sendUserMessage('sess-b', 'keep going');

    expect(pool.byDevice.get('device-b')?.messages).toEqual([
      { sessionId: 'sess-b', text: 'keep going' },
    ]);
    expect(pool.byDevice.get('device-a')?.messages).toEqual([]);
    const state = get(sessions).get('sess-b');
    expect(state?.entries.some((e) => e.kind === 'user' && e.text === 'keep going')).toBe(true);
  });

  it('keeps each device’s adoption policy apart and routes config reads/writes to its channel', () => {
    const enabled: AdoptStatePayload = {
      enabled: true,
      denylist: [],
      hooksInstalled: true,
      events: ['a'],
    };
    const disabled: AdoptStatePayload = {
      enabled: false,
      denylist: ['/p'],
      hooksInstalled: false,
      events: [],
    };
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);

    // A read goes to the ASKED device only; a write likewise.
    requestAdoptConfig('device-a');
    setAdoptConfig('device-b', { enabled: false, denylist: ['/p'] });
    expect(pool.byDevice.get('device-a')?.adoptConfigs).toEqual([undefined]);
    expect(pool.byDevice.get('device-b')?.adoptConfigs).toEqual([
      { enabled: false, denylist: ['/p'] },
    ]);

    // Each daemon's sealed adopt.state reply lands under ITS device — never overwriting the other's.
    // (A removed device dropping its policy state is pinned in multi-device.variants.test.ts.)
    pool.byDevice.get('device-a')!.emitAdoptState(enabled);
    pool.byDevice.get('device-b')!.emitAdoptState(disabled);
    expect(get(adoptStates).get('device-a')).toEqual(enabled);
    expect(get(adoptStates).get('device-b')).toEqual(disabled);
  });

  it('shares one channel-token mint across a connect wave, and a stale failure never clobbers a fresh mint', async () => {
    // ensureConnections is the production path that binds fetchChannelToken — drive it with an
    // injected fetch + fake connections to pin the share window (5s, token TTL 60s).
    vi.setSystemTime(0);
    let mints = 0;
    const fetchMock = vi.fn(
      (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ channelToken: `tok-${(mints += 1)}` }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pool = makeFakePool();
    ensureConnections({ relayUrl: 'ws://x', userId, devices: [DEVICE_A, DEVICE_B] }, pool.create);

    // Both channels dial in the same wave → ONE HTTP mint serves them.
    const tokenA = await pool.byDevice.get('device-a')!.options.getChannelToken();
    const tokenB = await pool.byDevice.get('device-b')!.options.getChannelToken();
    expect(tokenA).toBe('tok-1');
    expect(tokenB).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the share window a reconnect mints fresh (expiry renewal keeps working).
    vi.setSystemTime(6_000);
    await expect(pool.byDevice.get('device-a')!.options.getChannelToken()).resolves.toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A SLOW mint that fails after a newer one succeeded must not clear the newer entry.
    vi.setSystemTime(12_000);
    let failSlow: (reason: Error) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((_, reject) => {
          failSlow = reject;
        }),
    );
    const slow = pool.byDevice.get('device-a')!.options.getChannelToken();
    slow.catch(() => undefined); // observed below; muffle the direct handle
    vi.setSystemTime(18_000); // the slow mint's window lapsed → the next call mints anew
    await expect(pool.byDevice.get('device-b')!.options.getChannelToken()).resolves.toBe('tok-3');
    failSlow(new Error('slow mint died late'));
    await expect(slow).rejects.toThrow('slow mint died late');
    // The fresh entry survived the stale rejection: a caller inside its window re-uses it — no
    // fifth fetch (the four so far: the wave's, the 6s renewal, the slow one, and tok-3's).
    await expect(pool.byDevice.get('device-a')!.options.getChannelToken()).resolves.toBe('tok-3');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.unstubAllGlobals();
  });
});

/**
 * Worktree reaping (branch-actions T3): the delete dialog's opt-in rides the session's OWN device
 * channel and resolves with the daemon's sealed verdict — or the honest failure story (device
 * offline via relay.error, local timeout, no routed connection). Never optimistic.
 */
describe('reapWorkspace (branch-actions T3)', () => {
  it('sends the reap on the session own device and resolves the daemon ok verdict', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    seedSessionDevices([{ id: 'sess-reap', deviceId: 'device-b' }]);

    const outcome = reapWorkspace('sess-reap');
    const connB = pool.byDevice.get('device-b')!;
    expect(connB.reaps).toEqual(['sess-reap']);
    expect(pool.byDevice.get('device-a')!.reaps).toEqual([]);

    connB.emitWorkspaceReap({ sessionId: 'sess-reap', ok: true });
    await expect(outcome).resolves.toEqual({ ok: true });
  });

  it('resolves the daemon coded refusal as-is', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-dirty', deviceId: 'device-a' }]);

    const outcome = reapWorkspace('sess-dirty');
    pool.byDevice.get('device-a')!.emitWorkspaceReap({
      sessionId: 'sess-dirty',
      ok: false,
      code: 'dirty',
    });
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'dirty' });
  });

  it('resolves daemon-offline from the relay honest error, and ignores unrelated sessions', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-offline', deviceId: 'device-a' }]);

    const outcome = reapWorkspace('sess-offline');
    const connA = pool.byDevice.get('device-a')!;
    // A reap verdict for a DIFFERENT session must not settle this one.
    connA.emitWorkspaceReap({ sessionId: 'sess-other', ok: true });
    connA.emit(
      makeEnvelope({
        type: 'relay.error',
        userId,
        deviceId: 'device-a',
        sessionId: 'sess-offline',
        payload: { code: 'device_offline', regarding: 'workspace.reap' },
      }),
    );
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'daemon-offline' });
  });

  it('resolves no-connection for an unrouted session in a multi-device pool (no guessing)', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    await expect(reapWorkspace('sess-unrouted')).resolves.toEqual({
      ok: false,
      reason: 'no-connection',
    });
  });

  it('times out into an honest failure when nothing ever answers', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-silent', deviceId: 'device-a' }]);

    const outcome = reapWorkspace('sess-silent');
    vi.advanceTimersByTime(15_000);
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});

/**
 * Between-turns branch switch (branch-actions T4): same correlation contract as reapWorkspace —
 * routed to the session's OWN device, settled only by the daemon's sealed verdict / the relay's
 * honest offline error / the local timeout, never optimistic. Plus the supersede rule: a second
 * ask for the same session settles the first as no-connection (its stale timer must never fire
 * into the new ask's slot).
 */
describe('switchSessionBranch (branch-actions T4)', () => {
  function branchState(deviceId: string, sessionId: string, payload: unknown): Envelope {
    return makeEnvelope({ type: 'session.branch.state', userId, deviceId, sessionId, payload });
  }

  it('sends the switch on the session own device and resolves the daemon ok verdict', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    seedSessionDevices([{ id: 'sess-switch', deviceId: 'device-b' }]);

    const outcome = switchSessionBranch('sess-switch', 'feat/other');
    const connB = pool.byDevice.get('device-b')!;
    expect(connB.switches).toEqual([{ sessionId: 'sess-switch', branch: 'feat/other' }]);
    expect(pool.byDevice.get('device-a')!.switches).toEqual([]);

    connB.emit(branchState('device-b', 'sess-switch', { ok: true, branch: 'feat/other' }));
    await expect(outcome).resolves.toEqual({ ok: true, branch: 'feat/other' });
  });

  it('resolves the daemon coded refusal as-is', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-held', deviceId: 'device-a' }]);

    const outcome = switchSessionBranch('sess-held', 'main');
    pool.byDevice
      .get('device-a')!
      .emit(branchState('device-a', 'sess-held', { ok: false, code: 'checked-out-elsewhere' }));
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'checked-out-elsewhere' });
  });

  it('resolves daemon-offline from the relay honest error, and ignores unrelated sessions', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-sw-offline', deviceId: 'device-a' }]);

    const outcome = switchSessionBranch('sess-sw-offline', 'feat/other');
    const connA = pool.byDevice.get('device-a')!;
    // A verdict for a DIFFERENT session must not settle this one.
    connA.emit(branchState('device-a', 'sess-sw-other', { ok: true, branch: 'x' }));
    connA.emit(
      makeEnvelope({
        type: 'relay.error',
        userId,
        deviceId: 'device-a',
        sessionId: 'sess-sw-offline',
        payload: { code: 'device_offline', regarding: 'session.branch.switch' },
      }),
    );
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'daemon-offline' });
  });

  it('resolves no-connection for an unrouted session in a multi-device pool (no guessing)', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    await expect(switchSessionBranch('sess-sw-unrouted', 'feat/other')).resolves.toEqual({
      ok: false,
      reason: 'no-connection',
    });
  });

  it('times out into an honest failure when nothing ever answers', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-sw-silent', deviceId: 'device-a' }]);

    const outcome = switchSessionBranch('sess-sw-silent', 'feat/other');
    vi.advanceTimersByTime(15_000);
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('a second ask supersedes the first — the stale timer never fires into the new slot', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-sw-twice', deviceId: 'device-a' }]);

    const first = switchSessionBranch('sess-sw-twice', 'feat/one');
    vi.advanceTimersByTime(10_000); // deep into the first ask's window
    const second = switchSessionBranch('sess-sw-twice', 'feat/two');
    await expect(first).resolves.toEqual({ ok: false, reason: 'no-connection' }); // superseded

    // The FIRST ask's timer would fire now — it must not settle the second ask as timeout.
    vi.advanceTimersByTime(6_000);
    pool.byDevice
      .get('device-a')!
      .emit(branchState('device-a', 'sess-sw-twice', { ok: true, branch: 'feat/two' }));
    await expect(second).resolves.toEqual({ ok: true, branch: 'feat/two' });
  });
});

/**
 * Push for a PR (branch-actions T6): the third consumer of the shared ask machinery — routed to
 * the session's own device, settled by the daemon's sealed verdict (which carries the PR-link
 * facts) or the honest failure stories.
 */
describe('pushSessionBranch (branch-actions T6)', () => {
  function pushState(deviceId: string, sessionId: string, payload: unknown): Envelope {
    return makeEnvelope({ type: 'session.push.state', userId, deviceId, sessionId, payload });
  }

  it('sends the push on the session own device and resolves the PR-link facts', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A, DEVICE_B], options, pool.create);
    seedSessionDevices([{ id: 'sess-push', deviceId: 'device-a' }]);

    const outcome = pushSessionBranch('sess-push');
    const connA = pool.byDevice.get('device-a')!;
    expect(connA.pushes).toEqual(['sess-push']);
    expect(pool.byDevice.get('device-b')!.pushes).toEqual([]);

    connA.emit(
      pushState('device-a', 'sess-push', {
        ok: true,
        branch: 'telecode/fix-ab12',
        base: 'main',
        githubRepo: 'acme/app',
      }),
    );
    await expect(outcome).resolves.toEqual({
      ok: true,
      branch: 'telecode/fix-ab12',
      base: 'main',
      githubRepo: 'acme/app',
    });
  });

  it('resolves the daemon coded refusal as-is', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([{ id: 'sess-push-auth', deviceId: 'device-a' }]);

    const outcome = pushSessionBranch('sess-push-auth');
    pool.byDevice
      .get('device-a')!
      .emit(pushState('device-a', 'sess-push-auth', { ok: false, code: 'auth' }));
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'auth' });
  });

  it('resolves daemon-offline from the relay honest error and times out on silence (45s window)', async () => {
    const pool = makeFakePool();
    connectDevices([DEVICE_A], options, pool.create);
    seedSessionDevices([
      { id: 'sess-push-offline', deviceId: 'device-a' },
      { id: 'sess-push-silent', deviceId: 'device-a' },
    ]);

    const offline = pushSessionBranch('sess-push-offline');
    pool.byDevice.get('device-a')!.emit(
      makeEnvelope({
        type: 'relay.error',
        userId,
        deviceId: 'device-a',
        sessionId: 'sess-push-offline',
        payload: { code: 'device_offline', regarding: 'session.push' },
      }),
    );
    await expect(offline).resolves.toEqual({ ok: false, reason: 'daemon-offline' });

    const silent = pushSessionBranch('sess-push-silent');
    // A push gets MORE time than the 15s device-RPC default — the daemon's own git timeout is 30s.
    vi.advanceTimersByTime(15_000);
    let settled = false;
    void silent.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(30_000);
    await expect(silent).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
