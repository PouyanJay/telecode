/**
 * Pure formatter for a short, human OS descriptor ("macOS 15.4", "Ubuntu 24.04", "Windows"). Pure over
 * its inputs so it unit-tests across platforms without faking `node:os`/the filesystem; the impure
 * environment read lives in {@link detectOs} (./os-info).
 */
export interface OsFacts {
  /** `process.platform` / `os.platform()` — 'darwin' | 'linux' | 'win32' | … */
  readonly platform: NodeJS.Platform;
  /** `os.release()` — the kernel release (Darwin version on macOS). */
  readonly release: string;
  /** Contents of `/etc/os-release` on Linux (for the distro name), else null. */
  readonly osRelease: string | null;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** Map a Darwin kernel release to the macOS marketing version (Darwin 24 → macOS 15, 19 → 10.15). */
function formatMac(kernelRelease: string): string {
  const [majorRaw, minorRaw] = kernelRelease.split('.');
  const darwinMajor = Number(majorRaw);
  const minor = Number(minorRaw);
  if (!Number.isInteger(darwinMajor) || !Number.isInteger(minor)) return 'macOS';
  if (darwinMajor >= 20) return `macOS ${darwinMajor - 9}.${minor}`;
  if (darwinMajor >= 16) return `macOS 10.${darwinMajor - 4}`;
  return 'macOS';
}

/** Read a quoted value (`KEY="value"`) from /etc/os-release contents. */
function osReleaseField(osRelease: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(osRelease);
  if (!match) return null;
  return match[1]!.trim().replace(/^"(.*)"$/, '$1');
}

/** Prefer "<NAME> <VERSION_ID>" (e.g. "Ubuntu 24.04"); fall back to PRETTY_NAME, then "Linux". */
function formatLinux(osRelease: string | null): string {
  if (!osRelease) return 'Linux';
  const name = osReleaseField(osRelease, 'NAME');
  const versionId = osReleaseField(osRelease, 'VERSION_ID');
  if (name && versionId) return `${name} ${versionId}`;
  return osReleaseField(osRelease, 'PRETTY_NAME') ?? name ?? 'Linux';
}

export function formatOs(facts: OsFacts): string {
  switch (facts.platform) {
    case 'darwin':
      return formatMac(facts.release);
    case 'linux':
      return formatLinux(facts.osRelease);
    case 'win32':
      return 'Windows';
    default:
      return capitalize(facts.platform);
  }
}
