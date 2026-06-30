import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADOPT_SETTINGS, loadAdoptConfig, saveAdoptConfig } from './adopt-config';

describe('adopt-config store', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telecode-adopt-config-'));
    path = join(dir, 'adopt-config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the adopt-all default when the file is missing', async () => {
    expect(await loadAdoptConfig(path)).toEqual(DEFAULT_ADOPT_SETTINGS);
  });

  it('round-trips a saved config', async () => {
    await saveAdoptConfig(path, { enabled: false, denylist: ['/Users/me/secret'] });
    expect(await loadAdoptConfig(path)).toEqual({ enabled: false, denylist: ['/Users/me/secret'] });
  });

  it('degrades to the default on a corrupt file (never crashes)', async () => {
    await writeFile(path, '{ not valid json', 'utf8');
    expect(await loadAdoptConfig(path)).toEqual(DEFAULT_ADOPT_SETTINGS);
  });

  it('degrades to the default on valid JSON that fails the schema', async () => {
    await writeFile(path, JSON.stringify({ enabled: 'yes', denylist: [42] }), 'utf8');
    expect(await loadAdoptConfig(path)).toEqual(DEFAULT_ADOPT_SETTINGS);
  });
});
