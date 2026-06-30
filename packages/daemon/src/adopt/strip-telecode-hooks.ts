import { type ClaudeSettings } from './claude-settings';
import { isTelecodeHookCommand } from './telecode-hook-command';

/** The `hooks` map of `~/.claude/settings.json`: event name → matcher groups (the non-null shape). */
type HooksByEvent = NonNullable<ClaudeSettings['hooks']>;

/**
 * Drop telecode's hook entries from every event, pruning the empty groups/events it leaves behind. Used by
 * both install (idempotent re-add) and uninstall (clean removal), so we only ever touch entries telecode
 * created and leave the user's own hooks intact.
 */
export function stripTelecodeHooks(hooks: HooksByEvent): HooksByEvent {
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
