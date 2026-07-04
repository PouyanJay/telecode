import { describe, expect, it } from 'vitest';

import { renderLaunchdPlist } from './render-launchd-plist';

/**
 * Pure unit tests for the launchd plist renderer — the on-disk contract that makes the daemon a macOS
 * login service. String-in/string-out, so every branch (escaping, optional blocks, arg order) is
 * covered fast without touching the filesystem or launchctl.
 */
const base = {
  label: 'ai.telecode.daemon',
  programArguments: ['/usr/local/bin/node', '/opt/telecode/bin/telecode.mjs'],
  stdoutPath: '/home/u/.telecode/logs/daemon.log',
  stderrPath: '/home/u/.telecode/logs/daemon.err.log',
} as const;

describe('renderLaunchdPlist', () => {
  it('renders a valid plist header with the label and the auto-start / keep-alive keys', () => {
    const plist = renderLaunchdPlist(base);

    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('<key>Label</key>\n    <string>ai.telecode.daemon</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(plist.endsWith('</plist>\n')).toBe(true);
  });

  it('emits ProgramArguments in order, each a nested <string> child of <array>', () => {
    const plist = renderLaunchdPlist({
      ...base,
      programArguments: [
        '/usr/local/bin/node',
        '/opt/telecode/bin/telecode.mjs',
        '--relay-url',
        'wss://r/ws',
      ],
    });

    expect(plist).toContain(
      [
        '    <key>ProgramArguments</key>',
        '    <array>',
        '      <string>/usr/local/bin/node</string>',
        '      <string>/opt/telecode/bin/telecode.mjs</string>',
        '      <string>--relay-url</string>',
        '      <string>wss://r/ws</string>',
        '    </array>',
      ].join('\n'),
    );
  });

  it('escapes the five XML predefined entities in every value', () => {
    const plist = renderLaunchdPlist({
      ...base,
      programArguments: [`weird & "path" <a> 'b'`],
    });

    expect(plist).toContain(
      '<string>weird &amp; &quot;path&quot; &lt;a&gt; &apos;b&apos;</string>',
    );
    // The raw, unescaped characters must not survive inside element text.
    expect(plist).not.toContain('& "path"');
  });

  it('omits the optional WorkingDirectory and EnvironmentVariables blocks when not provided', () => {
    const plist = renderLaunchdPlist(base);

    expect(plist).not.toContain('WorkingDirectory');
    expect(plist).not.toContain('EnvironmentVariables');
  });

  it('renders EnvironmentVariables as an escaped key/value dict when provided', () => {
    const plist = renderLaunchdPlist({
      ...base,
      environmentVariables: { TELECODE_RELAY_URL: 'wss://r/ws', PATH: '/usr/bin:/bin' },
    });

    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>TELECODE_RELAY_URL</key>\n      <string>wss://r/ws</string>');
    expect(plist).toContain('<key>PATH</key>\n      <string>/usr/bin:/bin</string>');
  });

  it('renders the WorkingDirectory block when provided', () => {
    const plist = renderLaunchdPlist({ ...base, workingDirectory: '/home/u/project' });

    expect(plist).toContain('<key>WorkingDirectory</key>\n    <string>/home/u/project</string>');
  });
});
