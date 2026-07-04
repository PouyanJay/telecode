/**
 * Render a launchd LaunchAgent property list (pure — no filesystem, fully unit-testable as string
 * output). This is the on-disk contract that makes the daemon a macOS login service: `RunAtLoad` starts
 * it at login, `KeepAlive` restarts it on crash, and `StandardOut/ErrorPath` capture its logs. The
 * manager writes the returned string to `~/Library/LaunchAgents/<label>.plist`.
 */
export interface LaunchdPlistConfig {
  /** Reverse-DNS service label, e.g. `ai.telecode.daemon`. Also the plist filename stem. */
  readonly label: string;
  /** The full argument vector launchd execs, e.g. `[nodePath, binPath, '--relay-url', url]`. */
  readonly programArguments: readonly string[];
  /** Absolute path for the daemon's stdout log. */
  readonly stdoutPath: string;
  /** Absolute path for the daemon's stderr log. */
  readonly stderrPath: string;
  /** Optional working directory for the service process. */
  readonly workingDirectory?: string;
  /** Environment variables to inject — a GUI launchd session does not source the shell rc. */
  readonly environmentVariables?: Readonly<Record<string, string>>;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function arrayBlock(key: string, values: readonly string[]): string {
  // Array children nest two spaces deeper than the `<array>` tag (6 vs 4) — Apple's plist convention.
  return [
    `    <key>${key}</key>`,
    '    <array>',
    ...values.map((value) => `      <string>${escapeXml(value)}</string>`),
    '    </array>',
  ].join('\n');
}

function boolBlock(key: string, value: boolean): string {
  return `    <key>${key}</key>\n    <${value ? 'true' : 'false'}/>`;
}

function stringBlock(key: string, value: string): string {
  return `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`;
}

function environmentBlock(vars: Readonly<Record<string, string>>): string {
  const entries = Object.entries(vars);
  if (entries.length === 0) return '';
  const inner = entries
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');
  return `    <key>EnvironmentVariables</key>\n    <dict>\n${inner}\n    </dict>`;
}

/** Assemble the LaunchAgent plist. */
export function renderLaunchdPlist(config: LaunchdPlistConfig): string {
  const blocks = [
    stringBlock('Label', config.label),
    arrayBlock('ProgramArguments', config.programArguments),
    boolBlock('RunAtLoad', true),
    boolBlock('KeepAlive', true),
    stringBlock('StandardOutPath', config.stdoutPath),
    stringBlock('StandardErrorPath', config.stderrPath),
    ...(config.workingDirectory ? [stringBlock('WorkingDirectory', config.workingDirectory)] : []),
    ...(config.environmentVariables ? [environmentBlock(config.environmentVariables)] : []),
  ].filter((block) => block !== '');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    ...blocks,
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}
