/**
 * Resolve which device a session runs on, for the session view's header/rail attribution. A session in
 * the persisted registry names its device by the row's own `deviceId` — never by device-list order,
 * which mislabeled every session on a second machine. A session not in the registry yet (launched this
 * visit) runs on the watched device — the first listed one, the only device launches go to. A `deviceId`
 * that resolves to no listed device (revoked) is honestly `null`, not somebody else's name.
 */
export function resolveSessionDevice<Device extends { readonly id: string }>(input: {
  readonly sessionId: string;
  readonly sessions: readonly { readonly id: string; readonly deviceId: string }[];
  readonly devices: readonly Device[];
}): Device | null {
  const row = input.sessions.find((session) => session.id === input.sessionId);
  if (row) {
    return input.devices.find((device) => device.id === row.deviceId) ?? null;
  }
  return input.devices[0] ?? null;
}
