<script lang="ts">
  import { Button } from '@telecode/ui';

  import InboxCard from '$lib/components/InboxCard.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import RegistryErrorNotice from '$lib/components/RegistryErrorNotice.svelte';
  import SessionGroupHeader from '$lib/components/SessionGroupHeader.svelte';
  import SessionRow from '$lib/components/SessionRow.svelte';
  import { deviceStatus } from '$lib/devices';
  import { buildInboxAsks } from '$lib/inbox';
  import { launchDrawerOpen } from '$lib/launch-drawer';
  import { buildOnboardingSteps } from '$lib/onboarding';
  import { pairingInstructions } from '$lib/pairing-instructions';
  import { buildSessionRows, groupSessions, sessionCounts } from '$lib/session-groups';
  import {
    connectionState,
    decide,
    sessions as liveSessions,
    subscribe,
    watchedDaemonOnline,
  } from '$lib/session-store';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const device = $derived(data.devices[0] ?? null);

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

  // One shared clock for the waiting pills (30s resolution — minutes-level display).
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const asks = $derived(
    buildInboxAsks({
      live: $liveSessions,
      titleOf: (id) => data.sessions.find((s) => s.id === id)?.title ?? null,
      deviceNameOf: (id) => {
        const row = data.sessions.find((s) => s.id === id);
        return row
          ? (data.devices.find((d) => d.id === row.deviceId)?.name ?? null)
          : (device?.name ?? null);
      },
    }),
  );
  // Awaiting sessions whose asks aren't live yet (subscribe still in flight) fall back to plain rows.
  const askSessionIds = $derived(new Set(asks.map((a) => a.sessionId)));

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
  // the same source the system bar counts from, so the two surfaces can never disagree.
  const rows = $derived(
    buildSessionRows({
      registry: data.sessions,
      live: $liveSessions,
      deviceNameOf: (deviceId) => data.devices.find((d) => d.id === deviceId)?.name ?? null,
      watchedDeviceName: device?.name ?? null,
    }),
  );

  const groups = $derived(groupSessions(rows));
  const counts = $derived(sessionCounts(rows));
  const devicesOnline = $derived(
    data.devices.filter(
      (d, i) =>
        deviceStatus({
          lastSeenAt: d.lastSeenAt,
          isWatched: i === 0,
          connection: $connectionState,
          daemonOnline: $watchedDaemonOnline,
        }).online,
    ).length,
  );

  // First-run path (T14): pair → launch, shown when no device is paired yet.
  const onboardingSteps = $derived(
    buildOnboardingSteps({
      paired: device !== null,
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
{:else if !device}
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

  <div class="scroll">
    {#if rows.length === 0}
      <div class="empty">
        <p class="eyebrow">No sessions yet</p>
        <p class="sub">Launch a session on {device.name} to watch the agent work.</p>
        <Button variant="primary" onclick={() => launchDrawerOpen.set(true)}>Launch session</Button>
      </div>
    {:else}
      <div class="list">
        {#if asks.length > 0 || groups.awaiting.length > 0}
          <SessionGroupHeader label="Needs you" />
          {#if asks.length > 0}
            <ul class="asks" role="list" aria-live="polite">
              {#each asks as ask (`${ask.sessionId}:${ask.requestId}`)}
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
