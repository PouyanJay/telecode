import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

/**
 * The `~/.claude/settings.json` read/write layer shared by the `telecode hooks install|uninstall|status`
 * commands. It is a trust boundary (persisted JSON the user and other tools also edit), so its shape is
 * validated with zod rather than asserted with a cast — a corrupted `hooks` field must degrade to "no
 * telecode hooks", never crash. `passthrough()` preserves the user's other keys. The pure
 * {@link import('./strip-telecode-hooks').stripTelecodeHooks} transform lives in its own sibling module.
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
