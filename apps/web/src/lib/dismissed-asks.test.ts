import { describe, expect, it } from 'vitest';

import {
  dismissAsk,
  dismissedAskCountBySession,
  pruneDismissedAsks,
  readDismissedAsks,
  visibleInboxAsks,
} from './dismissed-asks';
import type { InboxAsk } from './inbox';

/** A key-honouring in-memory Storage, so read and write must agree on the key to round-trip. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

function ask(sessionId: string, requestId: string): InboxAsk {
  return {
    kind: 'permission',
    sessionId,
    sessionTitle: null,
    deviceName: null,
    requestId,
    toolName: 'Bash',
    input: {},
    decision: 'pending',
  };
}

describe('dismissed-asks persistence (board-housekeeping T1)', () => {
  it('round-trips a dismissal (read and write share the key) and survives a "reload"', () => {
    const storage = memoryStorage();
    dismissAsk(storage, 'req-1', 'sess-a');
    dismissAsk(storage, 'req-2', 'sess-b');
    // A fresh read = a reloaded tab.
    expect([...readDismissedAsks(storage).keys()].sort()).toEqual(['req-1', 'req-2']);
    expect(readDismissedAsks(storage).get('req-1')).toBe('sess-a');
  });

  it('reads an empty set for unset or corrupt storage (never throws)', () => {
    expect(readDismissedAsks(memoryStorage()).size).toBe(0);
    const corrupt: Pick<Storage, 'getItem'> = { getItem: () => '{not json' };
    expect(readDismissedAsks(corrupt).size).toBe(0);
    const wrongShape: Pick<Storage, 'getItem'> = { getItem: () => '{"a":1}' };
    expect(readDismissedAsks(wrongShape).size).toBe(0);
    const arrayShape: Pick<Storage, 'getItem'> = { getItem: () => '["req-1"]' };
    expect(readDismissedAsks(arrayShape).size).toBe(0);
  });

  it('prunes dismissals whose SESSION left awaiting (resolved/ended/deleted), keeping awaiting ones', () => {
    const storage = memoryStorage();
    dismissAsk(storage, 'req-live', 'sess-awaiting');
    dismissAsk(storage, 'req-resolved', 'sess-done');
    const pruned = pruneDismissedAsks(storage, new Set(['sess-awaiting']));
    expect([...pruned.keys()]).toEqual(['req-live']);
    // The prune is persisted — a reload agrees.
    expect([...readDismissedAsks(storage).keys()]).toEqual(['req-live']);
  });

  it('a slow live subscribe cannot fake a resolve: sessions still awaiting keep their dismissals', () => {
    // A named REGRESSION ANCHOR, not distinct coverage: the signature takes awaiting SESSION ids —
    // there is deliberately no "live ask list" parameter to get transiently-empty on reload (the
    // bug this design fixed; the e2e reload test drives the full path). Kept as documentation that
    // the parameter choice is load-bearing.
    const storage = memoryStorage();
    dismissAsk(storage, 'req-1', 'sess-awaiting');
    const pruned = pruneDismissedAsks(storage, new Set(['sess-awaiting']));
    expect(pruned.size).toBe(1);
  });
});

describe('inbox dismissal derivations (board-housekeeping T1)', () => {
  const asks: InboxAsk[] = [ask('sess-a', 'req-1'), ask('sess-a', 'req-2'), ask('sess-b', 'req-3')];

  it('hides dismissed asks from the inbox, keeping the rest in order', () => {
    const visible = visibleInboxAsks(asks, new Map([['req-2', 'sess-a']]));
    expect(visible.map((a) => a.requestId)).toEqual(['req-1', 'req-3']);
  });

  it('counts dismissed-but-still-pending asks per session (the row chip)', () => {
    const counts = dismissedAskCountBySession(
      asks,
      new Map([
        ['req-1', 'sess-a'],
        ['req-2', 'sess-a'],
      ]),
    );
    expect(counts.get('sess-a')).toBe(2);
    expect(counts.get('sess-b')).toBeUndefined();
  });

  it('a dismissal for an ask that no longer exists counts nowhere (stale id is inert)', () => {
    const stale = new Map([['req-gone', 'sess-a']]);
    expect(dismissedAskCountBySession(asks, stale).size).toBe(0);
    expect(visibleInboxAsks(asks, stale)).toHaveLength(3);
  });
});
