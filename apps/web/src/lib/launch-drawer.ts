import { writable } from 'svelte/store';

/**
 * Shared open-state for the launch drawer, which is mounted once in the app shell but triggered from many
 * places — the sidebar button, the mobile FAB, the ⌘N shortcut, and the dashboard's empty state. A single
 * store decouples those triggers from where the drawer lives; callers open it with `.set(true)`.
 */
export const launchDrawerOpen = writable(false);
