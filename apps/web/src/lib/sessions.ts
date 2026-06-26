import { type Envelope, type SessionStatusName } from '@telecode/protocol';

import { applyEnvelope, initialSessionState, type SessionState } from './session';

/**
 * The browser watches a device's whole channel, so it receives every session's frames; this is the live
 * per-session state, demultiplexed by `session_id`. Pure logic (no Svelte/DOM) so it unit-tests directly;
 * the reactive store in `session-store.ts` wraps it.
 */
export type SessionMap = ReadonlyMap<string, SessionState>;

/**
 * Fold one inbound relay frame into the per-session map, routed by `session_id`. A frame with no session
 * id — or one that doesn't change its session — returns the SAME map reference, so Svelte re-renders only
 * the affected row rather than the whole list on every WS frame.
 */
export function foldSessionFrame(map: SessionMap, envelope: Envelope): SessionMap {
  const id = envelope.session_id;
  if (id === undefined) return map;
  const current = map.get(id) ?? initialSessionState;
  const next = applyEnvelope(current, envelope);
  if (next === current) return map;
  const updated = new Map(map);
  updated.set(id, next);
  return updated;
}

/**
 * The device behind this channel went offline (Phase 4 Task 3): flip every still-live session to
 * `offline_paused` so the UI honestly shows it can't run until the daemon reconnects. Terminal sessions
 * (done/error) and already-paused ones are left untouched. Returns the SAME map when nothing changed.
 */
export function markChannelOffline(map: SessionMap): SessionMap {
  let changed = false;
  const next = new Map(map);
  for (const [id, state] of map) {
    if (
      state.status === 'running' ||
      state.status === 'starting' ||
      state.status === 'awaiting_input'
    ) {
      next.set(id, { ...state, status: 'offline_paused' });
      changed = true;
    }
  }
  return changed ? next : map;
}

/**
 * Dashboard sort priority: a blocked session ("awaiting input") is the loudest signal and sorts to the
 * top; live work next; everything terminal/idle last. Ties break on recency at the call site.
 */
export function statusPriority(status: SessionStatusName | 'idle'): number {
  switch (status) {
    case 'awaiting_input':
      return 0;
    case 'running':
    case 'starting':
      return 1;
    default:
      return 2; // done · error · offline_paused · idle
  }
}
