import { defineConfig } from 'vitest/config';

/**
 * Relay test config. `setupFiles` loads the repo-root `.env` so integration tests find `DATABASE_URL`
 * locally; timeouts are widened for real-Postgres round-trips. Pre-existing unit tests (echo, device-auth)
 * are unaffected.
 */
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
