import { defineConfig } from 'vitest/config';

// Pure-TS unit tests for the site's content/logic modules (the house pattern: logic in $lib/*.ts with
// thin Svelte renderers). No jsdom / component-render harness.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
