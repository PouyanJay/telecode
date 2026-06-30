import { describe, expect, it } from 'vitest';

import { formatOs } from './format-os';

const UBUNTU = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';

describe('formatOs', () => {
  it('maps a Darwin release to the macOS marketing version', () => {
    expect(formatOs({ platform: 'darwin', release: '24.4.0', osRelease: null })).toBe('macOS 15.4');
    expect(formatOs({ platform: 'darwin', release: '23.6.0', osRelease: null })).toBe('macOS 14.6');
    expect(formatOs({ platform: 'darwin', release: '19.6.0', osRelease: null })).toBe(
      'macOS 10.15',
    );
  });

  it('falls back to plain macOS below the mapped Darwin range and for unparseable releases', () => {
    // Darwin < 16 (pre-Sierra) and a non-numeric release both land on the conservative fallback.
    expect(formatOs({ platform: 'darwin', release: '15.6.0', osRelease: null })).toBe('macOS');
    expect(formatOs({ platform: 'darwin', release: 'unknown', osRelease: null })).toBe('macOS');
  });

  it('reads the distro name + version from /etc/os-release on Linux', () => {
    expect(formatOs({ platform: 'linux', release: '6.8.0', osRelease: UBUNTU })).toBe(
      'Ubuntu 24.04',
    );
  });

  it('falls back to PRETTY_NAME, then plain Linux', () => {
    expect(
      formatOs({ platform: 'linux', release: '6.8.0', osRelease: 'PRETTY_NAME="Arch Linux"' }),
    ).toBe('Arch Linux');
    expect(formatOs({ platform: 'linux', release: '6.8.0', osRelease: null })).toBe('Linux');
  });

  it('labels Windows and capitalizes any other platform', () => {
    expect(formatOs({ platform: 'win32', release: '10.0.22631', osRelease: null })).toBe('Windows');
    expect(formatOs({ platform: 'freebsd', release: '14.0', osRelease: null })).toBe('Freebsd');
  });
});
