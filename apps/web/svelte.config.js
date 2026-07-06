import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The product web app is deployed as a Node server container (Azure Container Apps), so it uses
 * adapter-node. The server reads PORT (set to 3000 in the image) and ORIGIN (the public https origin,
 * required behind the proxy so SvelteKit's CSRF check accepts the sign-in POST). See docs/deploy-azure.md.
 */
/** @type {import('@sveltejs/kit').Config} */
const config = {
  // `script: true` strips <script lang="ts"> with esbuild BEFORE the Svelte compiler. The compiler's
  // native type stripping (the plugin's default on Svelte 5) drops the annotation of an optional
  // parameter but leaves its `?` — `(message?: string)` becomes the invalid JS `(message?)` — which
  // breaks `vite build`/`vite dev` (and broke the prod deploy of 7e8f940) while svelte-check and
  // vitest stay green. esbuild erases the full TS syntax, so the build matches what the gates check.
  preprocess: vitePreprocess({ script: true }),
  kit: {
    adapter: adapter(),
  },
};

export default config;
