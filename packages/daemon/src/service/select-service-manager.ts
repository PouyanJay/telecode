import { createLaunchdManager } from './launchd-manager';
import type { ServiceManager, ServiceManagerDeps } from './service-manager';
import { createSystemdManager } from './systemd-manager';

/**
 * Pick the login-service implementation for a platform (the DI composition point): macOS → launchd,
 * Linux → systemd `--user`, Windows is a documented fast-follow. Returns `null` for an unsupported
 * platform so the caller can print guidance + the manual-foreground fallback.
 */
export function selectServiceManager(
  platform: NodeJS.Platform,
  deps: ServiceManagerDeps,
): ServiceManager | null {
  switch (platform) {
    case 'darwin':
      return createLaunchdManager(deps);
    case 'linux':
      return createSystemdManager(deps);
    default:
      return null;
  }
}
