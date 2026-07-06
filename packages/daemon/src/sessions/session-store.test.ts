import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStore, type PersistedSession } from './session-store';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'telecode-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SID = '11111111-1111-1111-1111-111111111111';

describe('createSessionStore', () => {
  it('round-trips a saved session through loadAll (the daemon-restart backfill source)', async () => {
    const store = createSessionStore({ dir: await tempDir() });
    const record: PersistedSession = {
      status: 'done',
      permissionMode: 'default',
      transcript: [
        { kind: 'user', text: 'do it' },
        { kind: 'message', text: 'done' },
      ],
    };
    store.save(SID, record);

    await vi.waitFor(
      async () => {
        const loaded = await store.loadAll();
        expect(loaded.get(SID)).toEqual(record);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('returns an empty map when the directory does not exist yet', async () => {
    const store = createSessionStore({ dir: join(tmpdir(), `telecode-missing-${randomUUID()}`) });
    expect((await store.loadAll()).size).toBe(0);
  });

  it('discards malformed JSON and non-session files rather than throwing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, `${SID}.json`), 'not valid json', 'utf8');
    await writeFile(join(dir, 'README.md'), 'ignored', 'utf8');
    const store = createSessionStore({ dir });
    expect((await store.loadAll()).size).toBe(0);
  });

  it('coalesces rapid saves down to the latest snapshot', async () => {
    const store = createSessionStore({ dir: await tempDir() });
    store.save(SID, { status: 'running', permissionMode: 'default', transcript: [] });
    store.save(SID, {
      status: 'awaiting_input',
      permissionMode: 'default',
      transcript: [{ kind: 'user', text: 'a' }],
    });
    store.save(SID, {
      status: 'done',
      permissionMode: 'acceptEdits',
      transcript: [
        { kind: 'user', text: 'a' },
        { kind: 'message', text: 'b' },
      ],
    });

    await vi.waitFor(
      async () => {
        const loaded = await store.loadAll();
        expect(loaded.get(SID)?.status).toBe('done');
        expect(loaded.get(SID)?.permissionMode).toBe('acceptEdits');
        expect(loaded.get(SID)?.transcript).toHaveLength(2);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('refuses a session id that is not a uuid (no path traversal into the store dir)', async () => {
    const store = createSessionStore({ dir: await tempDir() });
    store.save('../escape', { status: 'done', permissionMode: 'default', transcript: [] });
    // Nothing valid was written; loadAll stays empty.
    await vi.waitFor(
      async () => {
        expect((await store.loadAll()).size).toBe(0);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('writes session files owner-only (0600) — transcripts may contain sensitive code', async () => {
    const dir = await tempDir();
    const store = createSessionStore({ dir });
    store.save(SID, { status: 'done', permissionMode: 'default', transcript: [] });

    await vi.waitFor(
      async () => {
        const stats = await stat(join(dir, `${SID}.json`));
        expect(stats.mode & 0o777).toBe(0o600);
      },
      { timeout: 5000, interval: 50 },
    );
  });
});

describe('per-entry timestamps across a restart (Phase 3)', () => {
  it('round-trips entry ts stamps through save → loadAll', async () => {
    const store = createSessionStore({ dir: await tempDir() });
    const stamped: PersistedSession = {
      status: 'done',
      permissionMode: 'default',
      transcript: [
        { kind: 'user', text: 'do it', ts: 1_783_290_000_000 },
        { kind: 'message', text: 'done', ts: 1_783_290_001_000 },
      ],
    };
    store.save(SID, stamped);
    await vi.waitFor(async () => {
      expect((await store.loadAll()).get(SID)).toEqual(stamped);
    });
  });

  it('loads a pre-Phase-3 file whose entries carry no ts (never discarded, ts stays unknown)', async () => {
    const dir = await tempDir();
    const store = createSessionStore({ dir });
    const OLD_SID = '22222222-2222-2222-2222-222222222222';
    await writeFile(
      join(dir, `${OLD_SID}.json`),
      JSON.stringify({
        status: 'done',
        permissionMode: 'default',
        transcript: [{ kind: 'user', text: 'from an old daemon' }],
      }),
    );
    const loaded = await store.loadAll();
    expect(loaded.get(OLD_SID)?.transcript[0]?.ts).toBeUndefined();
    expect(loaded.get(OLD_SID)?.transcript[0]).toMatchObject({ text: 'from an old daemon' });
  });
});
