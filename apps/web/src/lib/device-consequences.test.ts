import { describe, expect, it } from 'vitest';

import { deviceConsequences } from './device-consequences';
import type { SessionStatus } from './session';

/**
 * `deviceConsequences` powers the revoke confirmation dialog: how many of a device's sessions the
 * revoke will end, and how many of those are waiting on the user right now. It overlays the LIVE
 * status (from the demuxed channel) onto the registry rows — the registry can lag (a dead daemon's
 * rows stay `running` in Postgres) — then counts only that device's non-terminal sessions.
 */
type Registry = { id: string; deviceId: string; status: SessionStatus };

const reg = (id: string, deviceId: string, status: SessionStatus): Registry => ({
  id,
  deviceId,
  status,
});

describe('deviceConsequences', () => {
  it('counts a device’s non-terminal sessions and the subset awaiting the user', () => {
    const registry = [
      reg('s1', 'dev-a', 'running'),
      reg('s2', 'dev-a', 'awaiting_input'),
      reg('s3', 'dev-a', 'done'), // terminal — not ended by revoke
      reg('s4', 'dev-b', 'running'), // other device — ignored
    ];
    expect(deviceConsequences('dev-a', registry, new Map())).toEqual({ ending: 2, awaiting: 1 });
  });

  it('overlays live status over a stale registry row (live wins)', () => {
    // The registry still says running, but the live channel shows the tool gate is up.
    const registry = [reg('s1', 'dev-a', 'running')];
    const live = new Map<string, SessionStatus>([['s1', 'awaiting_input']]);
    expect(deviceConsequences('dev-a', registry, live)).toEqual({ ending: 1, awaiting: 1 });
  });

  it('lets a live terminal status drop a session the registry still shows as active', () => {
    const registry = [reg('s1', 'dev-a', 'running')];
    const live = new Map<string, SessionStatus>([['s1', 'done']]);
    expect(deviceConsequences('dev-a', registry, live)).toEqual({ ending: 0, awaiting: 0 });
  });

  it('treats idle and offline_paused as non-terminal (still ended by a revoke)', () => {
    const registry = [reg('s1', 'dev-a', 'offline_paused'), reg('s2', 'dev-a', 'idle')];
    expect(deviceConsequences('dev-a', registry, new Map())).toEqual({ ending: 2, awaiting: 0 });
  });

  it('returns zeroes for a device with no sessions', () => {
    expect(deviceConsequences('dev-a', [], new Map())).toEqual({ ending: 0, awaiting: 0 });
  });
});
