import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Install / remove telecode's Claude Code hooks in `~/.claude/settings.json` (the `telecode hooks
 * install|uninstall|status` commands). Adoption is opt-in and reversible: installing adds telecode's
 * `command` hook to the relevant events; uninstalling removes exactly telecode's entries and leaves the
 * user's own hooks untouched. The edit is transparent (writes pretty JSON the user can inspect) and
 * idempotent (install replaces any prior telecode entries rather than duplicating them).
 *
 * A telecode hook is recognized by its `command` invoking the `telecode hook` bridge — see
 * {@link isTelecodeHookCommand}.
 */

/** The hook events telecode registers for adoption (Journey 1: PreToolUse gates tools + drives adoption). */
export const TELECODE_HOOK_EVENTS = ['PreToolUse'] as const;

interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}
type HooksByEvent = Record<string, MatcherGroup[]>;
interface ClaudeSettings {
  hooks?: HooksByEvent;
  [key: string]: unknown;
}

/**
 * A hook entry is telecode's when its command invokes the `telecode hook` bridge — i.e. it mentions
 * `telecode` (the bin, `@telecode/cli`, or a `telecode.mjs` path) and then the `hook` subcommand. Used for
 * idempotent install and a clean uninstall, so we only ever touch entries telecode created.
 */
export function isTelecodeHookCommand(command: string): boolean {
  return /telecode\b[\s\S]*\bhook\b/.test(command);
}

async function readSettings(settingsPath: string): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ClaudeSettings) : {};
  } catch {
    return {}; // missing or unparseable — start fresh (we never clobber valid JSON; see writeSettings)
  }
}

async function writeSettings(settingsPath: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** Drop telecode's hook entries from every event; prune the empty groups/events/object it leaves behind. */
function stripTelecodeHooks(hooks: HooksByEvent): HooksByEvent {
  const cleaned: HooksByEvent = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const keptGroups = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((hook) => !isTelecodeHookCommand(hook.command)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (keptGroups.length > 0) cleaned[event] = keptGroups;
  }
  return cleaned;
}

export interface InstallHooksOptions {
  readonly settingsPath: string;
  /** The command Claude Code runs — the `telecode hook` bridge (e.g. an absolute bin path + ' hook'). */
  readonly command: string;
  /** Hook `timeout` in seconds — set high so a remote decision isn't killed at the 600s default (AD-3). */
  readonly timeoutSeconds?: number;
}

/** Add telecode's hooks (idempotent: any prior telecode entries are replaced, user hooks preserved). */
export async function installHooks(options: InstallHooksOptions): Promise<void> {
  const settings = await readSettings(options.settingsPath);
  const hooks = stripTelecodeHooks(settings.hooks ?? {});
  const entry: CommandHook = {
    type: 'command',
    command: options.command,
    timeout: options.timeoutSeconds ?? 3600,
  };
  for (const event of TELECODE_HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { matcher: '*', hooks: [entry] }];
  }
  await writeSettings(options.settingsPath, { ...settings, hooks });
}

/** Remove exactly telecode's hooks; leave the user's own hooks (and the rest of settings) intact. */
export async function uninstallHooks(options: { settingsPath: string }): Promise<void> {
  const settings = await readSettings(options.settingsPath);
  if (!settings.hooks) return;
  const hooks = stripTelecodeHooks(settings.hooks);
  const next: ClaudeSettings = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  await writeSettings(options.settingsPath, next);
}

/** Report whether telecode's hooks are installed and for which events. */
export async function readHooksStatus(options: {
  settingsPath: string;
}): Promise<{ installed: boolean; events: string[] }> {
  const settings = await readSettings(options.settingsPath);
  const events = Object.entries(settings.hooks ?? {})
    .filter(([, groups]) =>
      groups.some((group) => group.hooks.some((hook) => isTelecodeHookCommand(hook.command))),
    )
    .map(([event]) => event);
  return { installed: events.length > 0, events };
}
