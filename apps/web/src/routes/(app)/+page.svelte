<script lang="ts">
  import { Button } from '@telecode/ui';

  import Onboarding from '$lib/components/Onboarding.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import RegistryErrorNotice from '$lib/components/RegistryErrorNotice.svelte';
  import SessionGroupHeader from '$lib/components/SessionGroupHeader.svelte';
  import SessionRow from '$lib/components/SessionRow.svelte';
  import { deviceStatus } from '$lib/devices';
  import { launchDrawerOpen } from '$lib/launch-drawer';
  import { buildOnboardingSteps } from '$lib/onboarding';
  import { pairingInstructions } from '$lib/pairing-instructions';
  import type { SessionState } from '$lib/session';
  import { groupSessions, sessionCounts, type SessionRow as Row } from '$lib/session-groups';
  import { connectionState, sessions as liveSessions } from '$lib/session-store';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const device = $derived(data.devices[0] ?? null);

  function deviceName(deviceId: string): string | null {
    return data.devices.find((d) => d.id === deviceId)?.name ?? null;
  }

  function firstPrompt(entries: SessionState['entries']): string | undefined {
    return entries.find((e) => e.kind === 'user')?.text;
  }

  // The persisted registry list (survives reloads) overlaid with live status from the channel; sessions
  // launched this visit but not yet in the registry are appended. Grouping/sorting is done by groupSessions.
  const rows = $derived.by<Row[]>(() => {
    const byId = new Map<string, Row>();
    for (const s of data.sessions) {
      byId.set(s.id, {
        id: s.id,
        title: s.title,
        status: s.status,
        deviceName: deviceName(s.deviceId),
        origin: s.origin,
        isContinuation: s.parentSessionId !== null,
        createdAt: s.createdAt,
      });
    }
    for (const [id, state] of $liveSessions) {
      const existing = byId.get(id);
      const status = state.status === 'idle' ? (existing?.status ?? 'starting') : state.status;
      const title = existing?.title ?? firstPrompt(state.entries) ?? null;
      byId.set(id, {
        id,
        title,
        status,
        deviceName: existing?.deviceName ?? device?.name ?? null,
        // A session launched this visit is `launched`; an adopted one carries its origin from the registry.
        origin: existing?.origin ?? 'launched',
        // Continuation link from either source: the persisted registry, or a live `session.chained` frame.
        isContinuation: (existing?.isContinuation ?? false) || state.parentSessionId !== null,
        createdAt: existing?.createdAt ?? new Date(),
      });
    }
    return [...byId.values()];
  });

  const groups = $derived(groupSessions(rows));
  const counts = $derived(sessionCounts(rows));
  const devicesOnline = $derived(
    data.devices.filter(
      (d, i) =>
        deviceStatus({ lastSeenAt: d.lastSeenAt, isWatched: i === 0, connection: $connectionState })
          .online,
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
        {#if groups.awaiting.length > 0}
          <SessionGroupHeader label="Needs your decision" />
          <ul class="rows" role="list">
            {#each groups.awaiting as row (row.id)}
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
