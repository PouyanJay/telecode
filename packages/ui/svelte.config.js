import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  // `script: true` for the same reason as apps/web/svelte.config.js: the compiler's native TS
  // stripping emits invalid JS for optional parameters; esbuild erases the full syntax.
  preprocess: vitePreprocess({ script: true }),
};
