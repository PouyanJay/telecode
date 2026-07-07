import {
  exportContentKey,
  generateContentKey,
  importContentKey,
  makeEnvelope,
  sealPayload,
  type AdoptSettings,
  type AdoptStatePayload,
  type RepoBranchesStatePayload,
  type SessionLaunchPayload,
} from '@telecode/protocol';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RelayConnection, type RelayConnectionOptions } from './relay-client';
import { type ContentKeyStore } from './content-key-store';
import type { RegistrySessionRow } from './session-groups';
import type { SessionMetaMap } from './session-meta';
import {
  adoptStates,
  answer,
  answerHandover,
  archiveSession,
  connect,
  deleteSessionForever,
  restoreSession,
  disconnect,
  launch,
  overlayMissingMetas,
  renameSession,
  repoBranches,
  requestAdoptConfig,
  requestRepoBranches,
  resetSessionTitle,
  resumeAsNew,
  seedSessionMetas,
  seedSessionTitleOverrides,
  sessionDevices,
  sessionMetas,
  sessionTitleOverrides,
  sessions,
  setAdoptConfig,
} from './session-store';

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
let branchRequests = 0;

function makeFakeConnection() {
  const launched: SessionLaunchPayload[] = [];
  const resumed: { sessionId: string; payload: { prompt: string; clientRef?: string } }[] = [];
  const subscribed: string[] = [];
  const answered: { sessionId: string; payload: unknown }[] = [];
  const handovers: { sessionId: string; payload: unknown }[] = [];
  const adoptConfigs: (AdoptSettings | undefined)[] = [];
  let emit: (envelope: ReturnType<typeof makeEnvelope>) => void = () => undefined;
  let emitAdoptState: (state: AdoptStatePayload) => void = () => undefined;
  let emitRepoBranches: (state: RepoBranchesStatePayload) => void = () => undefined;
  let fireReconnect: () => void = () => undefined;
  const create = (options: RelayConnectionOptions): RelayConnection => {
    emit = options.onEvent;
    emitAdoptState = (state) => options.onAdoptState?.(state);
    emitRepoBranches = (state) => options.onRepoBranches?.(state);
    fireReconnect = () => options.onReconnect?.();
    options.onStatus('connected');
    return {
      launch: (payload) => launched.push(payload),
      resumeNew: (sessionId, payload) => resumed.push({ sessionId, payload }),
      subscribe: (id) => subscribed.push(id),
      sendUserMessage: () => undefined,
      decide: () => undefined,
      answer: (sessionId, payload) => answered.push({ sessionId, payload }),
      answerHandover: (sessionId, payload) => handovers.push({ sessionId, payload }),
      control: () => undefined,
      sealTitle: async () => ({ payload: 'sealed-title', nonce: 'nonce' }),
      sendRepoBranchesRequest: () => {
        branchRequests += 1;
      },
      sendWorkspaceReap: () => undefined,
      switchBranch: () => undefined,
      sendAdoptConfig: (set) => adoptConfigs.push(set),
      close: () => undefined,
    };
  };
  return {
    create,
    launched,
    resumed,
    subscribed,
    answered,
    handovers,
    adoptConfigs,
    /** Simulate the daemon's sealed adopt.state reply (after the relay-client opens it). */
    adoptStateReply(state: AdoptStatePayload) {
      emitAdoptState(state);
    },
    /** Simulate the daemon's sealed repo.branches.state reply (branch-launch Phase B). */
    repoBranchesReply(state: RepoBranchesStatePayload) {
      emitRepoBranches(state);
    },
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
    /** Simulate the daemon offering a free-form handover on an adopted session (Journey 4). */
    handover(sessionId: string, requestId: string) {
      emit(
        makeEnvelope({
          type: 'agent.handover',
          userId,
          deviceId,
          sessionId,
          payload: { requestId, question: 'Which database?', summary: 'scaffolding an API' },
        }),
      );
    },
    /** Simulate the daemon registering a forked continuation linked to its parent (Journey 4). */
    chained(childSessionId: string, parentSessionId: string) {
      emit(
        makeEnvelope({
          type: 'session.chained',
          userId,
          deviceId,
          sessionId: childSessionId,
          payload: { clientRef: 'fork-1', parentSessionId },
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
    /** Simulate a live (cleartext, decrypted-upstream) `session.meta` frame for a session (ux Phase 6). */
    emitMeta(sessionId: string, payload: unknown) {
      emit(makeEnvelope({ type: 'session.meta', userId, deviceId, sessionId, payload }));
    },
  };
}

beforeEach(() => {
  branchRequests = 0;
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

  it('takes over a handover and links parent ↔ child on session.chained (Journey 4)', () => {
    // Real relay-minted UUIDs — session.chained's parentSessionId is validated as a UUID on the wire.
    const parentId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    fake.started(parentId);
    fake.handover(parentId, 'h1');

    answerHandover(parentId, { requestId: 'h1', answerText: 'Use Postgres.' });
    // Marked in-flight locally (submitting) and forwarded to the relay.
    expect(fake.handovers).toEqual([
      { sessionId: parentId, payload: { requestId: 'h1', answerText: 'Use Postgres.' } },
    ]);

    // The daemon registers the forked continuation → parent ↔ child linked across sessions.
    fake.chained(childId, parentId);
    const map = get(sessions);
    const parentEntry = map.get(parentId)?.entries.find((e) => e.kind === 'handover');
    expect(parentEntry?.kind).toBe('handover');
    if (parentEntry?.kind === 'handover') {
      expect(parentEntry.childSessionId).toBe(childId);
    }
    expect(map.get(childId)?.parentSessionId).toBe(parentId);
  });

  it('reads + writes the adoption policy and surfaces adopt.state per device (Journey 3)', () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    // A GET (no settings) then a SET are both forwarded to the device's connection.
    requestAdoptConfig(deviceId);
    setAdoptConfig(deviceId, { enabled: false, denylist: ['/Users/me/secret'] });
    expect(fake.adoptConfigs).toEqual([
      undefined,
      { enabled: false, denylist: ['/Users/me/secret'] },
    ]);

    // The daemon's sealed adopt.state reply (opened by the relay-client) lands under ITS device —
    // now carrying the setup status (hook-install state) the UI renders.
    expect(get(adoptStates).get(deviceId)).toBeUndefined();
    fake.adoptStateReply({
      enabled: false,
      denylist: ['/Users/me/secret'],
      hooksInstalled: false,
      events: [],
    });
    expect(get(adoptStates).get(deviceId)).toEqual({
      enabled: false,
      denylist: ['/Users/me/secret'],
      hooksInstalled: false,
      events: [],
    });
  });

  it('requests + surfaces the default repo branches per device, cleared on disconnect (Phase B)', () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    requestRepoBranches(deviceId);
    expect(branchRequests).toBe(1);

    // The daemon's sealed repo.branches.state reply lands under ITS device.
    expect(get(repoBranches).get(deviceId)).toBeUndefined();
    fake.repoBranchesReply({
      available: true,
      branches: ['main', 'develop'],
      defaultBranch: 'main',
    });
    expect(get(repoBranches).get(deviceId)).toEqual({
      available: true,
      branches: ['main', 'develop'],
      defaultBranch: 'main',
    });

    // Full teardown clears it — a later sign-in must never see another account's branch list.
    disconnect();
    expect(get(repoBranches).size).toBe(0);
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

describe('overlayMissingMetas (cold-load merge, T3)', () => {
  const meta = (title: string): SessionMetaMap => new Map([['s1', { title }]]);

  it('adds a decrypted meta only when the live map lacks it', () => {
    expect(overlayMissingMetas(new Map(), meta('cold')).get('s1')).toEqual({ title: 'cold' });
  });

  it('never overwrites an id the live map already holds (a live frame wins)', () => {
    expect(overlayMissingMetas(meta('live'), meta('stale cold decode')).get('s1')).toEqual({
      title: 'live',
    });
  });

  it('returns the SAME map instance when there is nothing new to add', () => {
    const live = meta('live');
    expect(overlayMissingMetas(live, new Map())).toBe(live);
    expect(overlayMissingMetas(live, meta('stale'))).toBe(live);
  });
});

describe('seedSessionMetas mid-flight race (T3)', () => {
  const row = (id: string, sealedMeta: string, sealedMetaNonce: string): RegistrySessionRow => ({
    id,
    title: null,
    status: 'done',
    deviceId,
    origin: 'launched',
    parentSessionId: null,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
    sealedMeta,
    sealedMetaNonce,
    sealedTitle: null,
    sealedTitleNonce: null,
  });

  it('a live session.meta arriving DURING the cold-load decrypt still wins', async () => {
    vi.useRealTimers(); // this test races real microtasks, not the launch timeout
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );

    // A REAL sealed blob for s1 with a STALE title — the cold-load decode genuinely produces it, so
    // "live wins" is a real assertion (not vacuously true because the decode yielded nothing).
    const contentKey = await generateContentKey(true);
    const sealed = await sealPayload({ title: 'stale cold-load title' }, contentKey);

    // A deferred content-key store: get() stays pending until the test releases it, so a live frame
    // can be injected while the decrypt is mid-flight.
    let releaseGet: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (releaseGet = resolve));
    const store: ContentKeyStore = {
      get: async () => {
        await gate;
        return importContentKey(await exportContentKey(contentKey), false);
      },
      put: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };

    seedSessionMetas([row('s1', sealed.payload, sealed.nonce)], store);

    // While the decrypt is gated, a live session.meta frame lands for the same session.
    fake.emitMeta('s1', { title: 'live wins' });
    expect(get(sessionMetas).get('s1')).toMatchObject({ title: 'live wins' });

    // Release the cold-load decode (it now resolves the STALE title) and flush its microtasks.
    releaseGet();
    await vi.waitFor(() => expect(get(sessionMetas).get('s1')).toBeDefined());
    await Promise.resolve();

    // The live frame's title is preserved — the overlay re-checked the CURRENT map and skipped s1.
    expect(get(sessionMetas).get('s1')).toMatchObject({ title: 'live wins' });
  });
});

describe('session rename (ux Phase 6 T6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Route a session to the single connected device so `connectionFor` resolves it. */
  function connectWithSession(
    fake: ReturnType<typeof makeFakeConnection>,
    sessionId: string,
  ): void {
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    fake.started(sessionId);
  }

  it('seals the title, PATCHes the rename BFF, and reflects it optimistically', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fake = makeFakeConnection();
    connectWithSession(fake, 'sess-1');

    const result = await renameSession('sess-1', 'My deploy run');
    expect(result).toEqual({ ok: true });

    // PATCHes the BFF with the SEALED blob the connection produced — never the plaintext title.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/sess-1/title',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const body: unknown = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ sealed_title: 'sealed-title', sealed_title_nonce: 'nonce' });
    // The actor sees the new name immediately (the relay also broadcasts to other tabs).
    expect(get(sessionTitleOverrides).get('sess-1')).toBe('My deploy run');
  });

  it('surfaces a failure and does NOT set the override when the BFF rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 502 })),
    );
    const fake = makeFakeConnection();
    connectWithSession(fake, 'sess-1');

    const result = await renameSession('sess-1', 'nope');
    expect(result.ok).toBe(false);
    expect(get(sessionTitleOverrides).has('sess-1')).toBe(false);
  });

  it('resets a title by PATCHing null and clearing the override', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fake = makeFakeConnection();
    connectWithSession(fake, 'sess-1');

    await renameSession('sess-1', 'temp name');
    expect(get(sessionTitleOverrides).get('sess-1')).toBe('temp name');

    const result = await resetSessionTitle('sess-1');
    expect(result).toEqual({ ok: true });
    const resetBody: unknown = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(resetBody).toEqual({ sealed_title: null });
    expect(get(sessionTitleOverrides).has('sess-1')).toBe(false);
  });

  it('reports "not connected" and never PATCHes when the session has no live channel', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    // No connect() this test → connectionFor returns null.
    const result = await renameSession('sess-orphan', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Not connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses (honestly) to rename a cleartext session — sealTitle returns null, no PATCH', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    // A cleartext (non-E2E) connection: its sealTitle yields null (no content key).
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      (options) => {
        options.onStatus('connected');
        return {
          launch: () => undefined,
          resumeNew: () => undefined,
          subscribe: () => undefined,
          sendUserMessage: () => undefined,
          decide: () => undefined,
          answer: () => undefined,
          answerHandover: () => undefined,
          control: () => undefined,
          sealTitle: async () => null,
          sendAdoptConfig: () => undefined,
          sendRepoBranchesRequest: () => undefined,
          sendWorkspaceReap: () => undefined,
          switchBranch: () => undefined,
          close: () => undefined,
        };
      },
    );
    const result = await renameSession('sess-clear', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('encrypted session');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seeds a cleartext sealed_title from the registry into the override map (cold load)', () => {
    const row: RegistrySessionRow = {
      id: 'sess-seed',
      title: null,
      status: 'done',
      deviceId,
      origin: 'launched',
      parentSessionId: null,
      createdAt: new Date('2026-07-01T10:00:00Z'),
      updatedAt: new Date('2026-07-01T10:00:00Z'),
      sealedMeta: null,
      sealedMetaNonce: null,
      sealedTitle: JSON.stringify({ title: 'renamed before reload' }),
      sealedTitleNonce: '',
    };
    seedSessionTitleOverrides([row], null);
    expect(get(sessionTitleOverrides).get('sess-seed')).toBe('renamed before reload');
  });
});

describe('session housekeeping actions (ux Phase 6 T7)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A live session with state in every per-session map: live entry, route, meta, rename override. */
  async function seedLiveSession(id: string): Promise<ReturnType<typeof makeFakeConnection>> {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    fake.started(id);
    fake.emitMeta(id, { title: 'derived title' });
    await renameSession(id, 'renamed');
    expect(get(sessions).has(id)).toBe(true);
    expect(get(sessionMetas).has(id)).toBe(true);
    expect(get(sessionTitleOverrides).has(id)).toBe(true);
    expect(get(sessionDevices).has(id)).toBe(true);
    return fake;
  }

  it('archiveSession PATCHes the BFF and forgets the session locally (no ghost row can resurrect)', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await seedLiveSession('sess-arch');

    const result = await archiveSession('sess-arch');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/sess-arch/archive',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const archiveCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/sess-arch/archive'),
    );
    expect(JSON.parse((archiveCall![1] as RequestInit).body as string)).toEqual({
      archived: true,
    });
    // AD-13: the acting tab purges every per-session map so the shared merge can't resurrect the row.
    expect(get(sessions).has('sess-arch')).toBe(false);
    expect(get(sessionMetas).has('sess-arch')).toBe(false);
    expect(get(sessionTitleOverrides).has('sess-arch')).toBe(false);
    expect(get(sessionDevices).has('sess-arch')).toBe(false);
  });

  it('restoreSession PATCHes archived:false and does NOT purge local state (the row returns)', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await seedLiveSession('sess-back');

    const result = await restoreSession('sess-back');
    expect(result).toEqual({ ok: true });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/sess-back/archive'));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ archived: false });
    // The whole point of restore-vs-archive: every per-session map keeps its state.
    expect(get(sessions).has('sess-back')).toBe(true);
    expect(get(sessionMetas).has('sess-back')).toBe(true);
    expect(get(sessionTitleOverrides).has('sess-back')).toBe(true);
    expect(get(sessionDevices).has('sess-back')).toBe(true);
  });

  it('keeps local state and surfaces the reason when archiving is refused (409 — still running)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === 'PATCH' && String(url).endsWith('/archive')
          ? new Response(null, { status: 409 })
          : new Response(null, { status: 204 }),
      ),
    );
    await seedLiveSession('sess-busy');

    const result = await archiveSession('sess-busy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('still going');
    expect(get(sessions).has('sess-busy')).toBe(true);
    expect(get(sessionMetas).has('sess-busy')).toBe(true);
  });

  it('deleteSessionForever DELETEs the BFF and forgets the session locally', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await seedLiveSession('sess-gone');

    const result = await deleteSessionForever('sess-gone');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/sess-gone',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(get(sessions).has('sess-gone')).toBe(false);
    expect(get(sessionMetas).has('sess-gone')).toBe(false);
    expect(get(sessionTitleOverrides).has('sess-gone')).toBe(false);
    expect(get(sessionDevices).has('sess-gone')).toBe(false);
  });

  it('keeps local state and reports failure when the delete is refused or unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? new Response(null, { status: 502 })
          : new Response(null, { status: 204 }),
      ),
    );
    await seedLiveSession('sess-stays');

    const result = await deleteSessionForever('sess-stays');
    expect(result.ok).toBe(false);
    expect(get(sessions).has('sess-stays')).toBe(true);
  });
});

describe('resume-as-new (ux Phase 6 T8)', () => {
  it('sends session.resume_new on the parent’s channel and resolves with the minted child id', async () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    fake.started('parent-1'); // routes the parent to this device's channel

    const pending = resumeAsNew('parent-1', 'continue where it left off');
    expect(fake.resumed).toHaveLength(1);
    const sent = fake.resumed[0]!;
    expect(sent.sessionId).toBe('parent-1');
    expect(sent.payload.prompt).toBe('continue where it left off');
    expect(sent.payload.clientRef).toBeDefined();

    // The daemon's child session.started echoes the clientRef — the promise resolves with the child.
    fake.started('child-9', sent.payload.clientRef);
    await expect(pending).resolves.toBe('child-9');
  });

  it('rejects when no device channel exists at all', async () => {
    await expect(resumeAsNew('sess-orphan', 'x')).rejects.toThrow(/not connected/i);
  });

  it('falls back to the SOLE connected device for an un-routed parent (registry-outage edge)', async () => {
    const fake = makeFakeConnection();
    connect(
      { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
      fake.create,
    );
    // The parent was never routed (no frame seen this visit) — with exactly one device, that device
    // is the honest target, mirroring launchTarget/connectionFor.
    const pending = resumeAsNew('sess-unrouted', 'continue it');
    expect(fake.resumed).toHaveLength(1);
    expect(fake.resumed[0]!.sessionId).toBe('sess-unrouted');
    fake.started('child-2', fake.resumed[0]!.payload.clientRef);
    await expect(pending).resolves.toBe('child-2');
  });

  it('rejects on timeout when no child ever starts', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeConnection();
      connect(
        { relayUrl: 'ws://x', userId, deviceId, getChannelToken: () => Promise.resolve('t') },
        fake.create,
      );
      fake.started('parent-2');
      const pending = resumeAsNew('parent-2', 'never answered');
      const outcome = expect(pending).rejects.toThrow(/timed out/i);
      vi.advanceTimersByTime(20_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
