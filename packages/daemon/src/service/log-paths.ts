import { join } from 'node:path';

/** The service log locations under `~/.telecode/logs`. */
export interface ServiceLogPaths {
  readonly logDir: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * The single source of truth for where a service manager writes its logs. Every platform points its
 * service's stdout/stderr at these files so `telecode service logs` (and `doctor`) read one uniform
 * location regardless of OS.
 */
export function resolveLogPaths(home: string): ServiceLogPaths {
  const logDir = join(home, '.telecode', 'logs');
  return {
    logDir,
    stdoutPath: join(logDir, 'daemon.log'),
    stderrPath: join(logDir, 'daemon.err.log'),
  };
}
