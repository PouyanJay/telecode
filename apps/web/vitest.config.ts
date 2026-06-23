import { configDefaults, defineConfig } from 'vitest/config';

// Keep Vitest (unit/component) away from the Playwright e2e specs, which use @playwright/test.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
