import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { adoptSettingsSchema, type AdoptSettings } from '@telecode/protocol';

/**
 * The daemon-local adoption policy store (Journey 3): the per-machine `{ enabled, denylist }` persisted at
 * `~/.telecode/adopt-config.json`, managed from the web (sealed `adopt.config`) and applied at runtime. The
 * file is a trust boundary (the daemon also reads it on its own start), so it is zod-validated; a
 * missing/corrupt file degrades to the **adopt-all default** (the user opts specific repos out via the
 * denylist), never a crash. The pure denylist matcher lives in the sibling `is-adoption-allowed` module.
 */
export const DEFAULT_ADOPT_SETTINGS: AdoptSettings = { enabled: true, denylist: [] };

export async function loadAdoptConfig(path: string): Promise<AdoptSettings> {
  try {
    const parsed = adoptSettingsSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : DEFAULT_ADOPT_SETTINGS;
  } catch {
    return DEFAULT_ADOPT_SETTINGS; // missing or invalid JSON — adopt-all default
  }
}

export async function saveAdoptConfig(path: string, settings: AdoptSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 0600: the adoption policy can name private repo paths — keep it owner-only, like credentials.json.
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
