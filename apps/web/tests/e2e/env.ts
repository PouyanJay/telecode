import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Repo root, relative to the web package Playwright runs from. */
export const REPO_ROOT = path.resolve(process.cwd(), '../..');

/**
 * Load the repo-root `.env` into `process.env` for the e2e processes (relay, the fake daemon, and the
 * spec's own relay HTTP calls). No-op in CI, where the job environment already provides the vars.
 */
export function loadRepoEnv(): void {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    const key = match?.[1];
    if (key && process.env[key] === undefined) {
      process.env[key] = match?.[2] ?? '';
    }
  }
}
