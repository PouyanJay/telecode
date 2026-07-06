import { makeEnvelope } from '@telecode/protocol';
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
  sessionDevices,
  sessions,
} from './session-store';

/**
 * Multi-device variant coverage (ux Phase 5, final task): the pool over 0/1/N devices, interleaved
 * cross-device traffic, presence flaps, and revoke-repool idempotence. The per-feature behavior is
 * pinned in session-store.pool.test.ts; these are the combinations.
 */
const userId = 'user-1';
const DEVICES = [
  { id: 'dev-1', publicKey: 'pk-1' },
  { id: 'dev-2', publicKey: null },
  { id: 'dev-3', publicKey: 'pk-3' },
];

interface Recorded {
  readonly options: RelayConnectionOptions;
  readonly subscribed: string[];
  readonly decisions: { sessionId: string; payload: unknown }[];
  closed: boolean;
}

function makePool() {
  const byDevice = new Map<string, Recorded>();
  let created = 0;
  const create = (options: RelayConnectionOptions): RelayConnection => {
    created += 1;
    const rec: Recorded = { options, subscribed: [], decisions: [], closed: false };
    byDevice.set(options.deviceId, rec);
    options.onStatus('connected');
    return {
      launch: () => undefined,
      subscribe: (id) => rec.subscribed.push(id),
      sendUserMessage: () => undefined,
      decide: (sessionId, payload) => rec.decisions.push({ sessionId, payload }),
      answer: () => undefined,
      answerHandover: () => undefined,
      control: () => undefined,
      sendAdoptConfig: () => undefined,
      close: () => {
        rec.closed = true;
      },
    };
  };
  return { create, byDevice, createdCount: () => created };
}

const options = { relayUrl: 'ws://x', userId, getChannelToken: () => Promise.resolve('t') };

function emit(
  pool: ReturnType<typeof makePool>,
  deviceId: string,
  type: 'session.started' | 'agent.permission_request' | 'device.presence',
  sessionId?: string,
  payload?: unknown,
): void {
  const rec = pool.byDevice.get(deviceId);
  rec?.options.onEvent(
    makeEnvelope({
      type,
      userId,
      deviceId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      payload: payload ?? {},
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  disconnect();
  vi.useRealTimers();
});

describe('multi-device variants', () => {
  it('an empty fleet pools nothing and reads idle', () => {
    const pool = makePool();
    connectDevices([], options, pool.create);
    expect(pool.createdCount()).toBe(0);
    expect(get(connectionState)).toBe('idle');
    expect(get(deviceChannels).size).toBe(0);
  });

  it('three devices stream interleaved and every send lands on its own channel', () => {
    const pool = makePool();
    connectDevices(DEVICES, options, pool.create);
    expect(pool.createdCount()).toBe(3);

    // Interleaved arrival order across channels — routing must not depend on sequencing.
    emit(pool, 'dev-2', 'session.started', 's2');
    emit(pool, 'dev-1', 'session.started', 's1');
    emit(pool, 'dev-3', 'session.started', 's3');
    emit(pool, 'dev-1', 'agent.permission_request', 's1', {
      requestId: 'r1',
      toolName: 'Write',
      input: {},
    });
    emit(pool, 'dev-3', 'agent.permission_request', 's3', {
      requestId: 'r3',
      toolName: 'Bash',
      input: {},
    });

    // Two concurrent approvals on two different devices resolve independently.
    decide('s3', { requestId: 'r3', behavior: 'allow' });
    decide('s1', { requestId: 'r1', behavior: 'deny' });

    expect(pool.byDevice.get('dev-1')?.decisions).toEqual([
      { sessionId: 's1', payload: { requestId: 'r1', behavior: 'deny' } },
    ]);
    expect(pool.byDevice.get('dev-3')?.decisions).toEqual([
      { sessionId: 's3', payload: { requestId: 'r3', behavior: 'allow' } },
    ]);
    expect(pool.byDevice.get('dev-2')?.decisions).toEqual([]);
    expect(get(sessionDevices).get('s2')).toBe('dev-2');
  });

  it('a presence flap on one device never disturbs the others’ live sessions', () => {
    const pool = makePool();
    connectDevices(DEVICES, options, pool.create);
    emit(pool, 'dev-1', 'session.started', 's1');
    emit(pool, 'dev-2', 'session.started', 's2');
    emit(pool, 'dev-3', 'session.started', 's3');

    // dev-2 drops while the others stay online.
    emit(pool, 'dev-2', 'device.presence', undefined, { online: false });
    const map = get(sessions);
    expect(map.get('s2')?.status).toBe('offline_paused');
    expect(map.get('s1')?.status).toBe('running');
    expect(map.get('s3')?.status).toBe('running');

    // dev-2 returns: only ITS session resubscribes (backfill); the others were never touched.
    emit(pool, 'dev-2', 'device.presence', undefined, { online: true });
    expect(pool.byDevice.get('dev-2')?.subscribed).toEqual(['s2']);
    expect(pool.byDevice.get('dev-1')?.subscribed).toEqual([]);
    expect(pool.byDevice.get('dev-3')?.subscribed).toEqual([]);
    expect(get(deviceChannels).get('dev-2')?.daemonOnline).toBe(true);
  });

  it('revoke → repool is idempotent: the gone device never resurrects, the rest never re-dial', () => {
    const pool = makePool();
    connectDevices(DEVICES, options, pool.create);
    emit(pool, 'dev-2', 'device.presence', undefined, { online: true });

    const remaining = [DEVICES[0]!, DEVICES[2]!];
    connectDevices(remaining, options, pool.create);
    expect(pool.byDevice.get('dev-2')?.closed).toBe(true);
    expect(get(deviceChannels).has('dev-2')).toBe(false);
    expect(get(adoptStates).has('dev-2')).toBe(false);

    // Re-pooling the same remaining fleet is a no-op: nothing new dialed, nothing resurrected.
    const before = pool.createdCount();
    connectDevices(remaining, options, pool.create);
    connectDevices(remaining, options, pool.create);
    expect(pool.createdCount()).toBe(before);
    expect(get(deviceChannels).has('dev-2')).toBe(false);
  });

  it('a sole-device fleet keeps the pre-pool degenerate behavior end to end', () => {
    const pool = makePool();
    connectDevices([DEVICES[0]!], options, pool.create);
    emit(pool, 'dev-1', 'session.started', 's1');

    // Presence pause + resume covers even unrouted sessions when the pool is a single channel.
    emit(pool, 'dev-1', 'device.presence', undefined, { online: false });
    expect(get(sessions).get('s1')?.status).toBe('offline_paused');
    emit(pool, 'dev-1', 'device.presence', undefined, { online: true });
    expect(pool.byDevice.get('dev-1')?.subscribed).toEqual(['s1']);
    expect(get(connectionState)).toBe('connected');
  });
});
