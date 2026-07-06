/**
 * Resolve which device a session runs on, for the session view's header/rail attribution. A session
 * in the persisted registry names its device by the row's own `deviceId`; a session not persisted
 * yet (launched or streamed this visit) is named by the store's live routing map (`liveDeviceId`,
 * recorded from its frames' envelope `device_id`). With neither, only a SOLE paired device is a
 * safe answer — among several, `null` (no name) beats somebody else's name. A `deviceId` that
 * resolves to no listed device (revoked) is honestly `null` too.
 */
export function resolveSessionDevice<Device extends { readonly id: string }>(input: {
  readonly sessionId: string;
  readonly sessions: readonly { readonly id: string; readonly deviceId: string }[];
  readonly devices: readonly Device[];
  /** The live routing map's entry for this session (session-store `sessionDevices`), if known. */
  readonly liveDeviceId?: string | null;
}): Device | null {
  const routedId =
    input.sessions.find((session) => session.id === input.sessionId)?.deviceId ??
    input.liveDeviceId ??
    null;
  if (routedId !== null) {
    return input.devices.find((device) => device.id === routedId) ?? null;
  }
  return input.devices.length === 1 ? input.devices[0]! : null;
}
