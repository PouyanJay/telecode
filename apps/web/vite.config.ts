import { readFileSync } from 'node:fs';

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Load the repo-root .env into process.env so SvelteKit's $env/dynamic/private sees the shared secrets
// (RELAY_SERVICE_SECRET, RELAY_HTTP_URL, …) — it reads process.env, not Vite's envDir. In CI these come
// from the job environment and the file is absent (no-op).
try {
  const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    const key = match?.[1];
    if (key && process.env[key] === undefined) {
      process.env[key] = match?.[2] ?? '';
    }
  }
} catch {
  // No repo-root .env (CI) — environment comes from the runner.
}

export default defineConfig({
  plugins: [sveltekit()],
});
