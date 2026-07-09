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

  it('prunes a resolved ask (session loaded, ask gone), keeping a still-pending one', () => {
    const storage = memoryStorage();
    dismissAsk(storage, 'req-live', 'sess-loaded');
    dismissAsk(storage, 'req-resolved', 'sess-loaded');
    // Both sessions are loaded live; only req-live is still a pending ask → req-resolved is swept.
    const pruned = pruneDismissedAsks(storage, {
      pendingRequestIds: new Set(['req-live']),
      loadedSessionIds: new Set(['sess-loaded']),
    });
    expect([...pruned.keys()]).toEqual(['req-live']);
    expect([...readDismissedAsks(storage).keys()]).toEqual(['req-live']);
  });

  it('keeps a dismissed pending ask whose session is NOT awaiting_input (needs_restart handover)', () => {
    // THE reported bug: a handover ask lives on a session the daemon lost (needs_restart) after a
    // restart — the ask is still live-pending, so the dismissal must survive (the old status-keyed
    // prune wiped it, so the card kept coming back with no chip).
    const storage = memoryStorage();
    dismissAsk(storage, 'req-handover', 'sess-needs-restart');
    const pruned = pruneDismissedAsks(storage, {
      pendingRequestIds: new Set(['req-handover']),
      loadedSessionIds: new Set(['sess-needs-restart']),
    });
    expect(pruned.size).toBe(1);
  });

  it('a slow live subscribe cannot fake a resolve: an unloaded session keeps its dismissal', () => {
    // On reload the live ask list is empty until each session subscribes+backfills. A dismissal is
    // pruned ONLY once its session is loaded (entries present) and the ask is gone — never while the
    // session is still unloaded (the reload transient that wiped dismissals).
    const storage = memoryStorage();
    dismissAsk(storage, 'req-1', 'sess-unloaded');
    const pruned = pruneDismissedAsks(storage, {
      pendingRequestIds: new Set(),
      loadedSessionIds: new Set(), // not loaded yet
    });
    expect(pruned.size).toBe(1);
  });

  it('sweeps a dismissal whose session is gone (deleted): loaded-elsewhere, ask absent', () => {
    const storage = memoryStorage();
    dismissAsk(storage, 'req-1', 'sess-deleted');
    // The board reports the deleted session as loaded (it was, before deletion) with no live ask.
    const pruned = pruneDismissedAsks(storage, {
      pendingRequestIds: new Set(),
      loadedSessionIds: new Set(['sess-deleted']),
    });
    expect(pruned.size).toBe(0);
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
