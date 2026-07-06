<script lang="ts">
  import { Button } from '@telecode/ui';

  import { page } from '$app/stores';

  import DeviceChips from '$lib/components/DeviceChips.svelte';
  import InboxCard from '$lib/components/InboxCard.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import RegistryErrorNotice from '$lib/components/RegistryErrorNotice.svelte';
  import SessionGroupHeader from '$lib/components/SessionGroupHeader.svelte';
  import SessionRow from '$lib/components/SessionRow.svelte';
  import {
    buildDeviceChips,
    deviceBoardHref,
    deviceFilterFromSearch,
    filterRowsByDevice,
  } from '$lib/device-filter';
  import { deviceChannelOf, deviceStatus } from '$lib/devices';
  import { buildInboxAsks } from '$lib/inbox';
  import { launchDrawerOpen } from '$lib/launch-drawer';
  import { buildOnboardingSteps } from '$lib/onboarding';
  import { pairingInstructions } from '$lib/pairing-instructions';
  import { buildSessionRows, groupSessions, sessionCounts } from '$lib/session-groups';
  import { buildThreadRows } from '$lib/threads';
  import {
    connectionState,
    decide,
    deviceChannels,
    sessionDevices,
    sessions as liveSessions,
    subscribe,
  } from '$lib/session-store';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const paired = $derived(data.devices.length > 0);
  // The board's device scope (chips, plan B4) — URL state, so /devices deep-links it and reload
  // keeps it. A stale id (revoked device) degrades to the unfiltered board.
  const deviceFilter = $derived(
    deviceFilterFromSearch(
      $page.url.searchParams,
      data.devices.map((d) => d.id),
    ),
  );
  const filteredDeviceName = $derived(
    deviceFilter === null ? null : (data.devices.find((d) => d.id === deviceFilter)?.name ?? null),
  );

  // Bring every awaiting session live so its pending asks are actionable from the inbox (the daemon
  // backfills each via session.history). Once-per-session (the set), not once-per-render.
  const requestedSubscribes = new Set<string>();
  $effect(() => {
    if ($connectionState !== 'connected') return;
    for (const s of data.sessions) {
      if (s.status === 'awaiting_input' && !requestedSubscribes.has(s.id)) {
        requestedSubscribes.add(s.id);
        subscribe(s.id);
      }
    }
  });

  // One shared clock for the waiting pills (30s resolution — the labels are minutes-level).
  const INBOX_CLOCK_INTERVAL_MS = 30_000;
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), INBOX_CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  // Which device a session runs on: its registry row, else the live routing map (a session
  // launched this visit before its row lands). Used for ask filtering + inbox device names.
  const deviceIdOfSession = $derived(
    (sessionId: string): string | null =>
      data.sessions.find((s) => s.id === sessionId)?.deviceId ??
      $sessionDevices.get(sessionId) ??
      null,
  );

  const asks = $derived(
    buildInboxAsks({
      live: $liveSessions,
      titleOf: (id) => data.sessions.find((s) => s.id === id)?.title ?? null,
      deviceNameOf: (id) => {
        const deviceId = deviceIdOfSession(id);
        return data.devices.find((d) => d.id === deviceId)?.name ?? null;
      },
    }),
  );
  // The chips scope the WHOLE board — the inbox included (an ask filters by its session's device).
  const visibleAsks = $derived(
    deviceFilter === null
      ? asks
      : asks.filter((ask) => deviceIdOfSession(ask.sessionId) === deviceFilter),
  );
  // Awaiting sessions whose asks aren't live yet (subscribe still in flight) fall back to plain rows.
  const askSessionIds = $derived(new Set(visibleAsks.map((a) => a.sessionId)));

  function onInboxApprove(sessionId: string, requestId: string): void {
    decide(sessionId, { requestId, behavior: 'allow' });
  }
  function onInboxReject(sessionId: string, requestId: string, message?: string): void {
    decide(sessionId, {
      requestId,
      behavior: 'deny',
      ...(message !== undefined ? { message } : {}),
    });
  }

  // The persisted registry overlaid with live status — built by the ONE shared merge (buildSessionRows),
  // then collapsed into threads (ux Phase 3: a parentSessionId chain is ONE conversation, one row). The
  // system bar counts the same collapsed rows, so the two surfaces can never disagree.
  const rows = $derived(
    buildThreadRows(
      buildSessionRows({
        registry: data.sessions,
        live: $liveSessions,
        deviceNameOf: (deviceId) => data.devices.find((d) => d.id === deviceId)?.name ?? null,
        deviceIdOf: (sessionId) => $sessionDevices.get(sessionId) ?? null,
      }),
    ),
  );

  // The chips' scope applies to everything below the header: list, groups, and the board stats.
  const visibleRows = $derived(filterRowsByDevice(rows, deviceFilter));
  const chips = $derived(
    buildDeviceChips({ devices: data.devices, channels: $deviceChannels, rows }),
  );

  const groups = $derived(groupSessions(visibleRows));
  const counts = $derived(sessionCounts(visibleRows));
  const devicesOnline = $derived(
    data.devices.filter((d) => {
      const channel = deviceChannelOf($deviceChannels, d.id);
      return deviceStatus({
        lastSeenAt: d.lastSeenAt,
        connection: channel.connection,
        daemonOnline: channel.daemonOnline,
        restOnline: d.online,
      }).online;
    }).length,
  );

  // First-run path (T14): pair → launch, shown when no device is paired yet.
  const onboardingSteps = $derived(
    buildOnboardingSteps({
      paired,
      hasSessions: rows.length > 0,
      instructions: pairingInstructions,
    }),
  );
</script>

<svelte:head>
  <title>Sessions · telecode</title>
</svelte:head>

{#if data.registryError}
  <!-- Error ≠ empty: a relay outage must never render the "pair your first device" onboarding. -->
  <RegistryErrorNotice />
{:else if !paired}
  <div class="onboard-scroll">
    <Onboarding steps={onboardingSteps} />
  </div>
{:else}
  <PageHeader title="Sessions" sub="Agents running on your machines, controlled from here.">
    {#snippet actions()}
      <dl class="stats">
        <div class="stat">
          <dd class="n">{counts.running}</dd>
          <dt class="t">Running</dt>
        </div>
        <div class="stat">
          <dd class="n" class:amber={counts.awaiting > 0}>{counts.awaiting}</dd>
          <dt class="t">Awaiting input</dt>
        </div>
        <div class="stat">
          <dd class="n">{devicesOnline}</dd>
          <dt class="t">{devicesOnline === 1 ? 'Device online' : 'Devices online'}</dt>
        </div>
      </dl>
    {/snippet}
  </PageHeader>

  {#if data.devices.length > 1}
    <DeviceChips {chips} active={deviceFilter} />
  {/if}

  <div class="scroll">
    {#if rows.length === 0}
      <div class="empty">
        <p class="eyebrow">No sessions yet</p>
        <p class="sub">Launch a session to watch the agent work.</p>
        <Button variant="primary" onclick={() => launchDrawerOpen.set(true)}>Launch session</Button>
      </div>
    {:else if visibleRows.length === 0}
      <!-- The scope is empty, the account is not: name the scope and offer the way out. -->
      <div class="empty">
        <p class="eyebrow">No sessions on {filteredDeviceName ?? 'this device'}</p>
        <p class="sub">Launch one here, or widen the view.</p>
        <div class="empty-actions">
          <Button variant="primary" onclick={() => launchDrawerOpen.set(true)}>
            Launch session
          </Button>
          <a class="show-all" href={deviceBoardHref(null)} data-sveltekit-noscroll>
            Show all devices
          </a>
        </div>
      </div>
    {:else}
      <div class="list">
        {#if visibleAsks.length > 0 || groups.awaiting.length > 0}
          <SessionGroupHeader label="Needs you" />
          {#if visibleAsks.length > 0}
            <ul class="asks" role="list" aria-live="polite">
              {#each visibleAsks as ask (`${ask.sessionId}:${ask.requestId}`)}
                <li>
                  <InboxCard {ask} {now} onapprove={onInboxApprove} onreject={onInboxReject} />
                </li>
              {/each}
            </ul>
          {/if}
          <ul class="rows" role="list">
            {#each groups.awaiting.filter((row) => !askSessionIds.has(row.id)) as row (row.id)}
              <li><SessionRow {row} /></li>
            {/each}
          </ul>
        {/if}
        {#if groups.active.length > 0}
          <SessionGroupHeader label="Active" />
          <ul class="rows" role="list">
            {#each groups.active as row (row.id)}
              <li><SessionRow {row} /></li>
            {/each}
          </ul>
        {/if}
        {#if groups.recent.length > 0}
          <SessionGroupHeader label="Recent" />
          <ul class="rows" role="list">
            {#each groups.recent as row (row.id)}
              <li><SessionRow {row} /></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .onboard-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .sub {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .stats {
    display: flex;
    align-items: stretch;
  }
  .stat {
    padding: 0 var(--space-5);
    text-align: right;
    border-left: 1px solid var(--border);
  }
  .stat:first-child {
    border-left: none;
  }
  .n {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 500;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .n.amber {
    color: var(--accent);
  }
  .t {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .list {
    max-width: 72rem;
    padding: var(--space-1) var(--space-4) var(--space-8);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .asks {
    list-style: none;
    margin: 0 0 var(--space-2);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    text-align: center;
    padding: var(--space-16) var(--space-4);
  }
  .empty-actions {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .show-all {
    color: var(--accent);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .show-all:hover {
    text-decoration: underline;
  }
  .show-all:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .empty .sub {
    margin: 0 0 var(--space-2);
    max-width: 28rem;
  }

  @media (max-width: 640px) {
    .stats {
      display: none;
    }
  }
</style>
