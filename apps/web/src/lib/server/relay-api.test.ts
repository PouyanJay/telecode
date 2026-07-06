import { afterEach, describe, expect, it, vi } from 'vitest';

import { approveDevice, listDevices, listRevokedDevices, listSessions } from './relay-api';

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

  it('returns ok:false on a 200 whose body is not JSON (parse failure is a failure, not emptiness)', async () => {
    stubFetch(() => Promise.resolve(new Response('<html>gateway</html>', { status: 200 })));
    const result = await listDevices('tok');
    expect(result).toEqual({ ok: false, items: [] });
  });

  it('returns ok:false on a 200 whose JSON does not match the contract (validated, not cast)', async () => {
    stubFetch(() => Promise.resolve(okJson({ devices: [{ id: 42 }] })));
    const result = await listDevices('tok');
    expect(result).toEqual({ ok: false, items: [] });
  });
});

describe('listRevokedDevices', () => {
  it('maps revoked devices with history count + pending-reauth on a 200', async () => {
    stubFetch(() =>
      Promise.resolve(
        okJson({
          devices: [
            {
              id: 'd1',
              name: 'old-mbp',
              os: 'macOS 15.4',
              revoked_at: '2026-07-05T10:00:00.000Z',
              session_count: 3,
              pending_reauth: true,
            },
          ],
        }),
      ),
    );
    const result = await listRevokedDevices('tok');
    expect(result.ok).toBe(true);
    expect(result.items[0]).toEqual({
      id: 'd1',
      name: 'old-mbp',
      os: 'macOS 15.4',
      revokedAt: new Date('2026-07-05T10:00:00.000Z'),
      sessionCount: 3,
      pendingReauth: true,
    });
  });

  it('returns ok:false on an error status (outage ≠ no revoked devices)', async () => {
    stubFetch(() => Promise.resolve(new Response('boom', { status: 502 })));
    expect(await listRevokedDevices('tok')).toEqual({ ok: false, items: [] });
  });

  it('returns ok:false on a body that does not match the contract', async () => {
    stubFetch(() => Promise.resolve(okJson({ devices: [{ id: 'd1' }] })));
    expect(await listRevokedDevices('tok')).toEqual({ ok: false, items: [] });
  });
});

describe('approveDevice', () => {
  it('reports restored + device name from the relay response', async () => {
    stubFetch(() => Promise.resolve(okJson({ ok: true, restored: true, device_name: 'mbp' })));
    expect(await approveDevice('ABCD-2345', 'user-1')).toEqual({
      ok: true,
      restored: true,
      deviceName: 'mbp',
    });
  });

  it('reports a fresh pair as not-restored', async () => {
    stubFetch(() => Promise.resolve(okJson({ ok: true, restored: false, device_name: null })));
    expect(await approveDevice('ABCD-2345', 'user-1')).toEqual({
      ok: true,
      restored: false,
      deviceName: null,
    });
  });

  it('tolerates an older relay that returns a bare { ok: true } (deploy skew)', async () => {
    stubFetch(() => Promise.resolve(okJson({ ok: true })));
    expect(await approveDevice('ABCD-2345', 'user-1')).toEqual({
      ok: true,
      restored: false,
      deviceName: null,
    });
  });

  it('reports failure on a non-ok status', async () => {
    stubFetch(() => Promise.resolve(new Response('nope', { status: 404 })));
    expect(await approveDevice('ABCD-2345', 'user-1')).toEqual({
      ok: false,
      restored: false,
      deviceName: null,
    });
  });

  it('reports failure when the relay is unreachable (fetch rejects), never throws', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await approveDevice('ABCD-2345', 'user-1')).toEqual({
      ok: false,
      restored: false,
      deviceName: null,
    });
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
