import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The product web app is deployed as a Node server container (Azure Container Apps), so it uses
 * adapter-node. The server reads PORT (set to 3000 in the image) and ORIGIN (the public https origin,
 * required behind the proxy so SvelteKit's CSRF check accepts the sign-in POST). See docs/deploy-azure.md.
 */
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
};

export default config;
