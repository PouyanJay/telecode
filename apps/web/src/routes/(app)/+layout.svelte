<script lang="ts">
  import type { Snippet } from 'svelte';

  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';

  import LaunchDrawer from '$lib/components/LaunchDrawer.svelte';
  import MobileNav from '$lib/components/MobileNav.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import SystemBar from '$lib/components/SystemBar.svelte';
  import { launchDrawerOpen } from '$lib/launch-drawer';
  import { sessionCounts } from '$lib/session-groups';
  import {
    connectionState,
    ensureConnection,
    sessions as liveSessions,
  } from '$lib/session-store';
  import type { LayoutData } from './$types';

  /**
   * The persistent authenticated shell (enterprise-ui §2): system bar + sidebar + scrollable content,
   * with the launch drawer and the phone bottom-nav. It owns the single relay connection — established
   * once when a device exists and never torn down across SPA navigation (reopen = reconnect, invariant
   * #7) — plus the drawer open-state and the ⌘N shortcut. Pages render only their own content into `main`.
   */
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
  const device = $derived(data.devices[0] ?? null);
  // Live working/blocked tallies for the system bar, straight from the demuxed session map.
  const counts = $derived(sessionCounts([...$liveSessions.values()]));

  // Open (and keep) the shared connection whenever a device is available; idempotent, so re-running on a
  // later pairing is safe. Client-only ($effect never runs on the server).
  $effect(() => {
    if (device && browser) {
      void ensureConnection({
        relayUrl: RELAY_URL,
        userId: data.user?.id ?? '',
        deviceId: device.id,
        daemonPublicKey: device.publicKey,
      });
    }
  });

  function openLaunchDrawer(): void {
    launchDrawerOpen.set(true);
  }

  function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openLaunchDrawer();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <SystemBar connection={$connectionState} {counts} />
  <Sidebar
    user={data.user}
    devices={data.devices}
    connection={$connectionState}
    {counts}
    onlaunch={openLaunchDrawer}
  />
  <main id="main" class="content">
    {@render children()}
  </main>
  <MobileNav onlaunch={openLaunchDrawer} />
</div>

<LaunchDrawer
  bind:open={$launchDrawerOpen}
  {device}
  repos={data.repos}
  githubConnected={data.githubConnected}
/>

<style>
  .app {
    height: 100dvh;
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .content {
    grid-row: 2;
    grid-column: 2;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  @media (max-width: 640px) {
    .app {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    .content {
      grid-column: 1 / -1;
    }
  }
</style>
