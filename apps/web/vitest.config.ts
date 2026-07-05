import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

// Keep Vitest (unit/component) away from the Playwright e2e specs, which use @playwright/test.
export default defineConfig({
  resolve: {
    alias: {
      // SvelteKit-runtime module; unit tests get a process-env stand-in (see the stub).
      '$env/dynamic/private': fileURLToPath(
        new URL('./tests/stubs/env-dynamic-private.ts', import.meta.url),
      ),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
