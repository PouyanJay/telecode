import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installHooks } from './hooks-install';
import { readHooksStatus } from './hooks-status';
import { uninstallHooks } from './hooks-uninstall';
import { isTelecodeHookCommand } from './telecode-hook-command';

/**
 * The `~/.claude/settings.json` installer (Journey 1, Task 7): adoption is opt-in, transparent (pretty
 * JSON), idempotent (no duplicate telecode entries), and reversible (uninstall removes exactly telecode's
 * hooks and preserves the user's own). Tested against a temp settings file — never the real global config.
 */
const COMMAND = '/usr/local/bin/telecode hook';

describe('hooks installer', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-hooks-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    settingsPath = join(dir, '.claude', 'settings.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function read(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  }
  async function seed(settings: unknown): Promise<void> {
    await writeFile(settingsPath, JSON.stringify(settings), 'utf8');
  }

  it('recognizes the telecode bridge command', () => {
    expect(isTelecodeHookCommand('/usr/local/bin/telecode hook')).toBe(true);
    expect(isTelecodeHookCommand('npx @telecode/cli hook')).toBe(true);
    expect(isTelecodeHookCommand('/path/telecode.mjs hook')).toBe(true);
    expect(isTelecodeHookCommand('eslint --fix')).toBe(false);
  });

  it('installs a PreToolUse hook into a missing settings file', async () => {
    await installHooks({ settingsPath, command: COMMAND, timeoutSeconds: 3600 });

    const settings = (await read()) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
    };
    const group = settings.hooks.PreToolUse[0]!;
    expect(group.matcher).toBe('*');
    expect(group.hooks[0]).toMatchObject({ type: 'command', command: COMMAND, timeout: 3600 });
    // All five lifecycle events telecode adopts on (Journey 1–4): gate/question + adopt/end + attention +
    // the free-form handover detector (Stop).
    expect(await readHooksStatus({ settingsPath })).toEqual({
      installed: true,
      events: ['PreToolUse', 'SessionStart', 'SessionEnd', 'Notification', 'Stop'],
    });
  });

  it('is idempotent — installing twice does not duplicate the telecode entry', async () => {
    await installHooks({ settingsPath, command: COMMAND });
    await installHooks({ settingsPath, command: COMMAND });
    const settings = (await read()) as { hooks: { PreToolUse: unknown[] } };
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('preserves the user’s own hooks and the rest of settings', async () => {
    await seed({
      model: 'claude-opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }],
      },
    });

    await installHooks({ settingsPath, command: COMMAND });
    const settings = (await read()) as {
      model?: string;
      hooks: {
        PreToolUse: { hooks: { command: string }[] }[];
        Stop: { hooks: { command: string }[] }[];
      };
    };

    expect(settings.model).toBe('claude-opus');
    const preCommands = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(preCommands).toContain('my-linter');
    expect(preCommands).toContain(COMMAND);
    // telecode now installs a Stop hook too (Journey 4) — the user's own Stop hook is preserved alongside it.
    const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(stopCommands).toContain('notify-me');
    expect(stopCommands).toContain(COMMAND);
  });

  it('uninstall removes telecode hooks but keeps the user’s (and prunes empties)', async () => {
    await seed({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }],
      },
    });

    await installHooks({ settingsPath, command: COMMAND });
    await uninstallHooks({ settingsPath });

    const settings = (await read()) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const commands = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toEqual(['my-linter']);
    expect(await readHooksStatus({ settingsPath })).toEqual({ installed: false, events: [] });
  });

  it('uninstall drops the hooks object entirely when only telecode hooks existed', async () => {
    await installHooks({ settingsPath, command: COMMAND });
    await uninstallHooks({ settingsPath });
    expect('hooks' in (await read())).toBe(false);
  });
});
