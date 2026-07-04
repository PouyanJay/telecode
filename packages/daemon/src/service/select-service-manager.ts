import { createLaunchdManager } from './launchd-manager';
import type { ServiceManager, ServiceManagerDeps } from './service-manager';

/**
 * Pick the login-service implementation for a platform (the DI composition point). macOS → launchd;
 * Linux → systemd `--user` (added in the Linux task); Windows is a documented fast-follow. Returns
 * `null` for an unsupported platform so the caller can print guidance + the manual-foreground fallback.
 */

/** Return the {@link ServiceManager} for `platform`, or `null` if telecode has no service impl for it. */
export function selectServiceManager(
  platform: NodeJS.Platform,
  deps: ServiceManagerDeps,
): ServiceManager | null {
  switch (platform) {
    case 'darwin':
      return createLaunchdManager(deps);
    default:
      return null;
  }
}
