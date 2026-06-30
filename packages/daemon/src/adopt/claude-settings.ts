import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { isTelecodeHookCommand } from './telecode-hook-command';

/**
 * The `~/.claude/settings.json` access layer shared by the `telecode hooks install|uninstall|status`
 * commands. It is a trust boundary (persisted JSON the user and other tools also edit), so its shape is
 * validated with zod rather than asserted with a cast — a corrupted `hooks` field must degrade to "no
 * telecode hooks", never crash. `passthrough()` preserves the user's other keys; the read/write/strip
 * helpers here are the only place that touches the file, so each operation file stays a thin one-export module.
 */
const commandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  timeout: z.number().optional(),
});
const matcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(commandHookSchema),
});
const claudeSettingsSchema = z
  .object({ hooks: z.record(z.array(matcherGroupSchema)).optional() })
  .passthrough();

export type CommandHook = z.infer<typeof commandHookSchema>;
type MatcherGroup = z.infer<typeof matcherGroupSchema>;
type HooksByEvent = Record<string, MatcherGroup[]>;
export type ClaudeSettings = z.infer<typeof claudeSettingsSchema>;

export async function readClaudeSettings(settingsPath: string): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = claudeSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {}; // unparseable/corrupt hooks → start fresh, never crash
  } catch {
    return {}; // missing or invalid JSON — start fresh (we never clobber valid JSON; see writeClaudeSettings)
  }
}

export async function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** Drop telecode's hook entries from every event; prune the empty groups/events/object it leaves behind. */
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
