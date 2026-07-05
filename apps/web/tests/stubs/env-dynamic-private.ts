/**
 * Vitest stand-in for SvelteKit's `$env/dynamic/private` (only available inside the Kit runtime).
 * Server modules under test read plain process env through the same shape.
 */
export const env: Record<string, string | undefined> = process.env;
