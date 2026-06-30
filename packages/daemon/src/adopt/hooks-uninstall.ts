import { readClaudeSettings, writeClaudeSettings, type ClaudeSettings } from './claude-settings';
import { stripTelecodeHooks } from './strip-telecode-hooks';

/**
 * Remove exactly telecode's hooks from `~/.claude/settings.json`; leave the user's own hooks (and the rest
 * of settings) intact. The mirror of {@link import('./hooks-install').installHooks}.
 */
export async function uninstallHooks(options: { settingsPath: string }): Promise<void> {
  const settings = await readClaudeSettings(options.settingsPath);
  if (!settings.hooks) return;
  const hooks = stripTelecodeHooks(settings.hooks);
  const next: ClaudeSettings = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  await writeClaudeSettings(options.settingsPath, next);
}
