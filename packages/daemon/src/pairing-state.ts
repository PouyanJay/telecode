import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/**
 * The on-disk pairing state (`~/.telecode/run/pairing.json`) — how a HEADLESS daemon's pairing code
 * becomes visible. The daemon writes it when a pairing prompt fires and removes it when the grant
 * settles; `telecode service status` reads it so a user whose background service is re-pairing can
 * find the code without spelunking the log file. A pairing code is a credential-in-waiting: the file
 * is owner-only, and an expired/corrupt file reads as absent so a stale code is never shown.
 */
const pairingStateSchema = z.object({
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  /** Epoch ms after which the code is dead (relay-side TTL). */
  expiresAt: z.number(),
});
export type PairingState = z.infer<typeof pairingStateSchema>;

export function resolvePairingStatePath(home: string): string {
  return join(home, '.telecode', 'run', 'pairing.json');
}

export async function savePairingState(state: PairingState, path: string): Promise<void> {
  // 0700 like the hook socket's run dir — everything under run/ is this user's runtime state. mkdir's
  // `mode` is ignored when the dir already exists (the single-instance lock creates run/ first), so
  // chmod unconditionally — otherwise another local user could see a pairing is in progress.
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export async function loadPairingState(
  path: string,
  now: () => number,
): Promise<PairingState | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = pairingStateSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.expiresAt > now() ? parsed.data : null;
}

export async function clearPairingState(path: string): Promise<void> {
  await rm(path, { force: true });
}
