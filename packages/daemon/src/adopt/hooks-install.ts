import { readClaudeSettings, writeClaudeSettings, type CommandHook } from './claude-settings';
import { stripTelecodeHooks } from './strip-telecode-hooks';

/**
 * Install telecode's Claude Code hooks into `~/.claude/settings.json`. Adoption is opt-in and reversible:
 * installing adds telecode's `command` hook to the relevant events, replacing any prior telecode entries
 * (idempotent) while leaving the user's own hooks untouched. The edit is transparent — it writes pretty
 * JSON the user can inspect. Removal lives in the sibling `hooks-uninstall` / status in `hooks-status`.
 */

/**
 * The hook events telecode registers for adoption:
 *  - `PreToolUse` — gate consequential tools + answer AskUserQuestion + drive adoption (Journey 1/2).
 *  - `SessionStart` — adopt a session before its first tool, incl. chat-only ones (Journey 3).
 *  - `SessionEnd` — end the adopted session when the Claude Code process exits (Journey 3).
 *  - `Notification` — surface "needs attention / went idle" cues (Journey 3).
 * (`Stop` is reserved for the free-form handover detector in a later journey.)
 */
const TELECODE_HOOK_EVENTS = ['PreToolUse', 'SessionStart', 'SessionEnd', 'Notification'] as const;

export interface InstallHooksOptions {
  readonly settingsPath: string;
  /** The command Claude Code runs — the `telecode hook` bridge (e.g. an absolute bin path + ' hook'). */
  readonly command: string;
  /** Hook `timeout` in seconds — set high so a remote decision isn't killed at the 600s default (AD-3). */
  readonly timeoutSeconds?: number;
}

/** Add telecode's hooks (idempotent: any prior telecode entries are replaced, user hooks preserved). */
export async function installHooks(options: InstallHooksOptions): Promise<void> {
  const settings = await readClaudeSettings(options.settingsPath);
  const hooks = stripTelecodeHooks(settings.hooks ?? {});
  const entry: CommandHook = {
    type: 'command',
    command: options.command,
    timeout: options.timeoutSeconds ?? 3600,
  };
  for (const event of TELECODE_HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { matcher: '*', hooks: [entry] }];
  }
  await writeClaudeSettings(options.settingsPath, { ...settings, hooks });
}
