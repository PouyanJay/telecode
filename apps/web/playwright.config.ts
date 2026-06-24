import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. `globalSetup` boots the relay (the process Playwright's `webServer` can't poll on an HTTP
 * port); `webServer` runs the SvelteKit dev server; the session spec pairs its own device + fake daemon.
 * The browser then drives the real page through the full stack.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // All specs share one relay + Postgres + the single dev-login user, so run them serially (one worker)
  // to avoid cross-file races on that shared state — mirrors the relay suite's `fileParallelism: false`.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite dev --port 5173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
