import { readClaudeSettings } from './claude-settings';
import { isTelecodeHookCommand } from './telecode-hook-command';

/** Report whether telecode's hooks are installed in `~/.claude/settings.json` and for which events. */
export async function readHooksStatus(options: {
  settingsPath: string;
}): Promise<{ installed: boolean; events: string[] }> {
  const settings = await readClaudeSettings(options.settingsPath);
  const events = Object.entries(settings.hooks ?? {})
    .filter(([, groups]) =>
      groups.some((group) => group.hooks.some((hook) => isTelecodeHookCommand(hook.command))),
    )
    .map(([event]) => event);
  return { installed: events.length > 0, events };
}
