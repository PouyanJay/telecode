import { isSessionEndStatus } from '@telecode/protocol';

import type { SessionStatus } from './session';

/** What revoking a device will do to its sessions — the confirmation dialog's real numbers. */
export interface DeviceConsequences {
  /** Non-terminal sessions the revoke will end. */
  readonly ending: number;
  /** Of those, how many are waiting on the user right now (a gate/question/handover). */
  readonly awaiting: number;
}

/** A registry session carrying the fields the consequence count needs. */
interface RegistrySession {
  readonly id: string;
  readonly deviceId: string;
  readonly status: SessionStatus;
}

/**
 * Count what revoking `deviceId` will end. Live status (from the demuxed channel, keyed by session id)
 * overlays the registry row — the registry lags reality (a dead daemon's rows stay `running` in
 * Postgres, a just-opened gate isn't persisted) — then only that device's non-terminal sessions count,
 * with `awaiting_input` ones also tallied as "waiting on you".
 */
export function deviceConsequences(
  deviceId: string,
  registry: readonly RegistrySession[],
  liveStatus: ReadonlyMap<string, SessionStatus>,
): DeviceConsequences {
  let ending = 0;
  let awaiting = 0;
  for (const session of registry) {
    if (session.deviceId !== deviceId) continue;
    const status = liveStatus.get(session.id) ?? session.status;
    // A revoke ends every non-terminal session on the device; ended ones are already over.
    if (isSessionEndStatus(status)) continue;
    ending += 1;
    if (status === 'awaiting_input') awaiting += 1;
  }
  return { ending, awaiting };
}

/**
 * The revoke confirmation's body copy, driven by the real counts. Always states the identity
 * consequence (a revoke bricks the device's credentials); adds the session toll when there is one,
 * and names the "waiting on you right now" subset because that's the one the user might not expect.
 */
export function revokeConsequenceText(
  name: string,
  { ending, awaiting }: DeviceConsequences,
): string {
  const identity = `Revoking ${name} ends its access — the daemon must re-authorize to reconnect.`;
  if (ending === 0) {
    return `${identity} It has no active sessions.`;
  }
  const sessions = `${ending} active ${ending === 1 ? 'session' : 'sessions'} will end`;
  if (awaiting === 0) {
    return `${identity} ${sessions}.`;
  }
  const waiting =
    awaiting === 1 ? 'one is waiting on you right now' : `${awaiting} are waiting on you right now`;
  return `${identity} ${sessions} — ${waiting}.`;
}
