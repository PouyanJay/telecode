import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Load the repo-root `.env` into `process.env`, filling only keys not already set. A deliberately
 * minimal `KEY=value` parser (no dotenv dependency) shared by the db CLIs and the vitest setup. In CI
 * the env is provided by the runner and the file is absent — this is then a no-op.
 */
export function loadDotenv(): void {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, '.env'), 'utf8');
  } catch {
    return; // No .env on disk (CI) — environment comes from the runner.
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key !== undefined && process.env[key] === undefined) {
      process.env[key] = value ?? '';
    }
  }
}
