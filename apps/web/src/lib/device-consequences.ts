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

// A revoke ends every non-terminal session on the device; these three are already over.
const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['done', 'error']);

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
    if (TERMINAL.has(status)) continue;
    ending += 1;
    if (status === 'awaiting_input') awaiting += 1;
  }
  return { ending, awaiting };
}
