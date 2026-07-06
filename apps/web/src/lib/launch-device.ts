import { deviceChannelOf, deviceStatus } from './devices';
import type { DeviceChannelState } from './session-store';

/**
 * The launch drawer's device picker model (ux Phase 5): which devices can be launched on, with
 * honest per-device presence, and which one to preselect. Pure — the drawer renders it.
 */
export interface LaunchDeviceOption {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
}

/** The fields the picker needs from a paired device (a structural slice of `RelayDevice`). */
export interface LaunchableDevice {
  readonly id: string;
  readonly name: string;
  readonly lastSeenAt: Date | null;
  readonly online: boolean | null;
}

/** One pickable option per paired device, presence resolved like every other surface. */
export function buildLaunchDeviceOptions(
  devices: readonly LaunchableDevice[],
  channels: ReadonlyMap<string, DeviceChannelState>,
  now: number = Date.now(),
): LaunchDeviceOption[] {
  return devices.map((device) => {
    const channel = deviceChannelOf(channels, device.id);
    const status = deviceStatus(
      {
        lastSeenAt: device.lastSeenAt,
        connection: channel.connection,
        daemonOnline: channel.daemonOnline,
        restOnline: device.online,
      },
      now,
    );
    return { id: device.id, name: device.name, online: status.online };
  });
}

/**
 * The device to preselect: the sole one, else the first online one (the most likely target), else
 * the first listed — an offline pick still submits and fails honestly via the relay's
 * offline-launch path ("device offline"), which beats refusing to offer anything.
 */
export function defaultLaunchDeviceId(options: readonly LaunchDeviceOption[]): string | null {
  if (options.length === 0) return null;
  return (options.find((option) => option.online) ?? options[0]!).id;
}
