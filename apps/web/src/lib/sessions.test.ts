import { makeEnvelope, type Envelope } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { foldSessionFrame, statusPriority, type SessionMap } from './sessions';

const USER = 'u_1';
const DEVICE = 'd_1';

function frame(sessionId: string, type: Envelope['type'], payload: unknown): Envelope {
  return makeEnvelope({ type, userId: USER, deviceId: DEVICE, sessionId, payload });
}

describe('multi-session demux (foldSessionFrame)', () => {
  it('routes each session’s frames to its own state, keyed by session_id', () => {
    let map: SessionMap = new Map();
    map = foldSessionFrame(map, frame('a', 'session.started', {}));
    map = foldSessionFrame(map, frame('b', 'session.started', {}));
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
    expect(map.get('a')?.status).toBe('running');
    expect(map.get('b')?.status).toBe('running');
  });

  it('updates only the affected session (others keep their reference for cheap re-render)', () => {
    let map: SessionMap = new Map();
    map = foldSessionFrame(map, frame('a', 'session.started', {}));
    map = foldSessionFrame(map, frame('b', 'session.started', {}));
    const bBefore = map.get('b');

    map = foldSessionFrame(map, frame('a', 'agent.message', { text: 'hi' }));
    expect(map.get('a')?.entries).toHaveLength(1);
    expect(map.get('b')).toBe(bBefore); // unchanged session is the same object reference
    expect(map.get('b')?.entries).toHaveLength(0);
  });

  it('returns the same map reference for a no-op (no session id, or an unchanged session)', () => {
    let map: SessionMap = new Map();
    map = foldSessionFrame(map, frame('a', 'session.started', {}));
    const noId = makeEnvelope({
      type: 'agent.message',
      userId: USER,
      deviceId: DEVICE,
      payload: {},
    });
    expect(foldSessionFrame(map, noId)).toBe(map);
    // An invalid payload doesn't change the session, so the map is returned unchanged too.
    expect(foldSessionFrame(map, frame('a', 'agent.message', { notText: 1 }))).toBe(map);
  });

  it('reseeds one session from session.history without touching the others', () => {
    let map: SessionMap = new Map();
    map = foldSessionFrame(map, frame('a', 'session.started', {}));
    map = foldSessionFrame(map, frame('b', 'session.started', {}));
    map = foldSessionFrame(
      map,
      frame('a', 'session.history', {
        status: 'done',
        entries: [
          { kind: 'user', text: 'do it' },
          { kind: 'message', text: 'done' },
        ],
      }),
    );
    expect(map.get('a')?.status).toBe('done');
    expect(map.get('a')?.entries.map((e) => e.kind)).toEqual(['user', 'message']);
    expect(map.get('b')?.status).toBe('running'); // untouched
  });
});

describe('dashboard sort priority', () => {
  it('puts awaiting-input first, live work next, terminal/idle last', () => {
    expect(statusPriority('awaiting_input')).toBeLessThan(statusPriority('running'));
    expect(statusPriority('running')).toBeLessThan(statusPriority('done'));
    expect(statusPriority('starting')).toBe(statusPriority('running'));
    expect(statusPriority('offline_paused')).toBe(statusPriority('error'));
  });
});
