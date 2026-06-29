<script lang="ts">
  import { Panel } from '@telecode/ui';

  import PageHeader from '$lib/components/PageHeader.svelte';
  import { deviceStatus } from '$lib/devices';
  import { connectionState } from '$lib/session-store';
  import type { PageData } from './$types';

  /**
   * Paired devices — the machines that run agents on the user's behalf (never the cloud). Lists what we
   * persist (name, id, presence from `lastSeenAt` + the live channel) and routes to pairing. Revoking a
   * device needs a relay endpoint that does not exist yet, so it is intentionally omitted rather than
   * shown as a dead control.
   */
  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Devices · telecode</title>
</svelte:head>

<PageHeader title="Devices" sub="Machines paired to your account. Agents run here, never in the cloud." />

<div class="scroll">
  <div class="content">
    {#if data.devices.length === 0}
      <div class="empty">
        <p class="eyebrow">No devices paired</p>
        <p class="sub">Pair a machine to run agents on it.</p>
        <a class="cta cta-primary" href="/activate">Pair a device</a>
      </div>
    {:else}
      <Panel title="Paired devices" meta="{data.devices.length} total">
        <ul class="devices" role="list">
          {#each data.devices as device, i (device.id)}
            {@const status = deviceStatus({
              lastSeenAt: device.lastSeenAt,
              isWatched: i === 0,
              connection: $connectionState,
            })}
            <li class="row hairline-b">
              <span class="dot" data-tone={status.tone} aria-hidden="true"></span>
              <div class="id">
                <span class="name" title={device.name}>{device.name}</span>
                <span class="did mono">{device.id.slice(0, 14)}</span>
              </div>
              <span class="seen mono">{status.online ? 'online · now' : `offline · ${status.lastSeen}`}</span>
            </li>
          {/each}
        </ul>
      </Panel>
      <div class="actions">
        <a class="cta cta-secondary" href="/activate">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M6.5 2.5v8M2.5 6.5h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          Pair a new device
        </a>
      </div>
    {/if}
  </div>
</div>

<style>
  .sub {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .content {
    max-width: 52rem;
    padding: var(--space-6);
  }
  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
  }
  .row:last-child {
    border-bottom: none;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: var(--text-muted);
  }
  .dot[data-tone='success'] {
    background: var(--success);
  }
  .dot[data-tone='warning'] {
    background: var(--warning);
  }
  .id {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-size: var(--text-sm);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .did {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .seen {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .actions {
    margin-top: var(--space-5);
  }
  /* Navigation CTAs are real links styled to read as buttons (enterprise-ui §3: links are links). */
  .cta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }
  .cta:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .cta-primary {
    background: var(--primary);
    color: var(--primary-text);
  }
  .cta-primary:hover {
    background: var(--accent-hover);
  }
  .cta-secondary {
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
  }
  .cta-secondary:hover {
    background: var(--bg-muted);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
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
  }

  @media (max-width: 640px) {
    .content {
      padding: var(--space-4);
    }
  }
</style>
