import { describe, expect, it } from 'vitest';

import { renderSystemdUnit } from './render-systemd-unit';

/**
 * Pure unit tests for the systemd `--user` unit renderer — the on-disk contract that makes the daemon a
 * Linux login service. String-in/string-out, so escaping, optional Environment lines, and the section
 * layout are covered without touching the filesystem or systemctl.
 */
const base = {
  description: 'telecode daemon',
  execStart: ['/usr/bin/node', '/opt/telecode/bin/telecode.mjs', '--relay-url', 'wss://r/ws'],
  stdoutPath: '/home/u/.telecode/logs/daemon.log',
  stderrPath: '/home/u/.telecode/logs/daemon.err.log',
} as const;

describe('renderSystemdUnit', () => {
  it('renders the [Unit], [Service], and [Install] sections', () => {
    const unit = renderSystemdUnit(base);

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Description=telecode daemon');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('always restarts and appends stdout/stderr to the shared log files', () => {
    const unit = renderSystemdUnit(base);

    // Restart=always (not on-failure) covers clean-exit hand-offs — see render-systemd-unit.ts.
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('StandardOutput=append:/home/u/.telecode/logs/daemon.log');
    expect(unit).toContain('StandardError=append:/home/u/.telecode/logs/daemon.err.log');
  });

  it('defaults RestartSec to 5 and honours a provided value', () => {
    expect(renderSystemdUnit(base)).toContain('RestartSec=5');
    expect(renderSystemdUnit({ ...base, restartSec: 10 })).toContain('RestartSec=10');
  });

  it('quotes every ExecStart argument so paths with spaces survive systemd parsing', () => {
    const unit = renderSystemdUnit({
      ...base,
      execStart: [
        '/usr/bin/node',
        '/opt/my telecode/bin/telecode.mjs',
        '--relay-url',
        'wss://r/ws',
      ],
    });

    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/my telecode/bin/telecode.mjs" "--relay-url" "wss://r/ws"',
    );
  });

  it('emits an Environment line per variable when provided', () => {
    const unit = renderSystemdUnit({ ...base, environment: { TELECODE_RELAY_URL: 'wss://r/ws' } });

    expect(unit).toContain('Environment="TELECODE_RELAY_URL=wss://r/ws"');
  });

  it('omits Environment lines when none are provided', () => {
    const unit = renderSystemdUnit(base);

    expect(unit).not.toContain('Environment=');
  });
});
