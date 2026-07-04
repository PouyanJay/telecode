import type { CommandResult } from './command-runner';

/**
 * A human-readable detail for a failed service-tool call (`launchctl`/`systemctl`): its trimmed stderr,
 * or the bare exit code when stderr is empty. Shared by every {@link import('./service-manager').ServiceManager}
 * so the failure-message shape stays consistent across platforms.
 */
export function commandDetail(result: CommandResult): string {
  return result.stderr.trim() || `exit ${result.code}`;
}
