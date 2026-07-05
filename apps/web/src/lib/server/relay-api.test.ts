import { afterEach, describe, expect, it, vi } from 'vitest';

import { listDevices, listSessions } from './relay-api';

/**
 * Error ≠ empty (honesty pass T4): a relay outage must be distinguishable from "you have no devices /
 * sessions" — the UI renders an error state for the former and onboarding/empty for the latter. These
 * reads therefore return `{ ok, items }`, never a bare array that flattens failure into emptiness.
 */
function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listDevices', () => {
  it('returns ok:true with mapped devices on a 200', async () => {
    stubFetch(() =>
      Promise.resolve(
        okJson({
          devices: [
            {
              id: 'd1',
              name: 'mbp',
              os: 'macOS 15.4',
              last_seen_at: '2026-07-05T10:00:00.000Z',
              public_key: null,
            },
          ],
        }),
      ),
    );
    const result = await listDevices('tok');
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'd1', name: 'mbp', os: 'macOS 15.4' });
    expect(result.items[0]!.lastSeenAt).toEqual(new Date('2026-07-05T10:00:00.000Z'));
  });

  it('returns ok:true with no items when the user genuinely has no devices', async () => {
    stubFetch(() => Promise.resolve(okJson({ devices: [] })));
    const result = await listDevices('tok');
    expect(result).toEqual({ ok: true, items: [] });
  });

  it('returns ok:false when the relay responds with an error status', async () => {
    stubFetch(() => Promise.resolve(new Response('boom', { status: 502 })));
    const result = await listDevices('tok');
    expect(result).toEqual({ ok: false, items: [] });
  });

  it('returns ok:false when the relay is unreachable (fetch rejects)', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await listDevices('tok');
    expect(result).toEqual({ ok: false, items: [] });
  });
});

describe('listSessions', () => {
  it('returns ok:true with mapped sessions on a 200', async () => {
    stubFetch(() =>
      Promise.resolve(
        okJson({
          sessions: [
            {
              id: 's1',
              device_id: 'd1',
              title: null,
              status: 'running',
              created_at: '2026-07-05T09:00:00.000Z',
              updated_at: '2026-07-05T09:30:00.000Z',
              ended_at: null,
            },
          ],
        }),
      ),
    );
    const result = await listSessions('tok');
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({ id: 's1', deviceId: 'd1', status: 'running' });
  });

  it('returns ok:false when the relay responds with an error status', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 500 })));
    const result = await listSessions('tok');
    expect(result).toEqual({ ok: false, items: [] });
  });

  it('returns ok:false when the relay is unreachable (fetch rejects)', async () => {
    stubFetch(() => Promise.reject(new Error('network down')));
    const result = await listSessions('tok');
    expect(result).toEqual({ ok: false, items: [] });
  });
});
