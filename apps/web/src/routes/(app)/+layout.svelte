<script lang="ts">
  import type { Snippet } from 'svelte';

  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';

  import { page } from '$app/stores';

  import { applyAttentionBadge } from '$lib/attention';
  import LaunchDrawer from '$lib/components/LaunchDrawer.svelte';
  import MobileNav from '$lib/components/MobileNav.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import SidebarResizer from '$lib/components/SidebarResizer.svelte';
  import SystemBar from '$lib/components/SystemBar.svelte';
  import { launchDrawerOpen } from '$lib/launch-drawer';
  import { buildSessionRows, sessionCounts } from '$lib/session-groups';
  import { buildThreadRows } from '$lib/threads';
  import {
    connectionState,
    ensureConnection,
    sessions as liveSessions,
    watchedDaemonOnline,
  } from '$lib/session-store';
  import {
    DEFAULT_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    readSidebarWidth,
    writeSidebarWidth,
  } from '$lib/sidebar-width';
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
  // The system bar and sidebar badge count the SAME rows the dashboard lists (registry overlaid with
  // live status via the one shared buildSessionRows, collapsed into threads — ux Phase 3) — the tallies
  // can never disagree between surfaces. Counting live-only used to miss persisted awaiting sessions.
  const mergedRows = $derived(
    buildThreadRows(
      buildSessionRows({
        registry: data.sessions,
        live: $liveSessions,
        deviceNameOf: () => null,
        watchedDeviceName: null,
      }),
    ),
  );
  const counts = $derived(sessionCounts(mergedRows));
  const sessionTotal = $derived(mergedRows.length);

  // Operator-adjustable sidebar width: seed from storage on the client, persist on every change.
  let sidebarWidth = $state(browser ? readSidebarWidth(localStorage) : DEFAULT_SIDEBAR_WIDTH);
  $effect(() => {
    if (browser) writeSidebarWidth(localStorage, sidebarWidth);
  });

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

  // Tab attention badge: "(N)" title prefix + amber-dot favicon while sessions await a decision.
  // Re-applied on navigation too ($page dependency) — each page sets its own <title> before effects
  // run, so the badge always decorates the fresh title instead of fighting it.
  $effect(() => {
    void $page.url;
    if (browser) applyAttentionBadge(document, counts.awaiting);
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

<div class="app" style="--sidebar-width: {sidebarWidth}px">
  <SystemBar connection={$connectionState} {counts} />
  <Sidebar
    user={data.user}
    devices={data.devices}
    connection={$connectionState}
    daemonOnline={$watchedDaemonOnline}
    {sessionTotal}
    onlaunch={openLaunchDrawer}
  />
  <SidebarResizer
    bind:width={sidebarWidth}
    min={MIN_SIDEBAR_WIDTH}
    max={MAX_SIDEBAR_WIDTH}
    onreset={() => (sidebarWidth = DEFAULT_SIDEBAR_WIDTH)}
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
    grid-template-columns: var(--sidebar-width, 240px) minmax(0, 1fr);
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
