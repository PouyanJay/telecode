import { type Envelope } from '@telecode/protocol';

import { applyEnvelope, initialSessionState, type SessionState } from './session';

/**
 * The browser watches a device's whole channel, so it receives every session's frames; this is the live
 * per-session state, demultiplexed by `session_id`. Pure logic (no Svelte/DOM) so it unit-tests directly;
 * the reactive store in `session-store.ts` wraps it. Dashboard bucketing/tallies live in `session-groups.ts`.
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
 * A device went offline (Phase 4 Task 3): flip ITS still-live sessions — the ids in `scope` — to
 * `offline_paused` so the UI honestly shows they can't run until that daemon reconnects. Scoped per
 * device (ux Phase 5): with a fleet, one machine dropping must never pause another's sessions.
 * Terminal (done/error) and already-paused sessions are untouched. Returns the SAME map when
 * nothing changed.
 */
export function markChannelOffline(map: SessionMap, scope: ReadonlySet<string>): SessionMap {
  let changed = false;
  const next = new Map(map);
  for (const [id, state] of map) {
    if (
      scope.has(id) &&
      (state.status === 'running' ||
        state.status === 'starting' ||
        state.status === 'awaiting_input' ||
        // A between-turns adopted session is live too — an offline device can't honor a takeover,
        // so the AT YOUR TERMINAL pill (and its live composer) must pause honestly with the rest.
        state.status === 'waiting_local')
    ) {
      next.set(id, { ...state, status: 'offline_paused' });
      changed = true;
    }
  }
  return changed ? next : map;
}
