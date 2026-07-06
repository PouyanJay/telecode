import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/**
 * The daemon's local credential store (`~/.telecode/credentials.json`). After pairing once, the daemon
 * reconnects with the saved device token — no env vars, no re-pairing. The X25519 keypair is kept here
 * for E2E in Phase 3 (the private key never leaves the machine). Written `0600`.
 */
const credentialsSchema = z.object({
  deviceToken: z.string().min(1),
  userId: z.string().min(1),
  deviceId: z.string().min(1),
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});
export type StoredCredentials = z.infer<typeof credentialsSchema>;

const DEFAULT_PATH = join(homedir(), '.telecode', 'credentials.json');

export async function loadCredentials(
  path: string = DEFAULT_PATH,
): Promise<StoredCredentials | null> {
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
    return null; // a corrupt file is the same as no file — the caller pairs fresh
  }
  const parsed = credentialsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function saveCredentials(
  credentials: StoredCredentials,
  path: string = DEFAULT_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}
