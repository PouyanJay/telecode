import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// The marketing site is fully prerendered (every route is static — see src/routes/+layout.ts), so it
// deploys to any static host / CDN (telecode.io) with no server. The product PWA lives separately.
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
};

export default config;
