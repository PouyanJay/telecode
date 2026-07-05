<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button, Panel } from '@telecode/ui';

  import PageHeader from '$lib/components/PageHeader.svelte';
  import RegistryErrorNotice from '$lib/components/RegistryErrorNotice.svelte';
  import { deviceStatus } from '$lib/devices';
  import { connectionState } from '$lib/session-store';
  import type { ActionData, PageData } from './$types';

  /**
   * Paired devices — the machines that run agents on the user's behalf (never the cloud). Shows each
   * device's name, OS, and honest presence (from the live channel), and lets the owner revoke access. The
   * revoke is verification-gated: a click reveals an inline confirm, the form posts to the relay (which
   * scopes it to the owner), and on success SvelteKit reruns the load so the row drops out.
   */
  let { data, form }: { data: PageData; form: ActionData } = $props();

  let confirmingId = $state<string | null>(null);
  let revokingId = $state<string | null>(null);
</script>

<svelte:head>
  <title>Devices · telecode</title>
</svelte:head>

<PageHeader title="Devices" sub="Machines paired to your account. Agents run here, never in the cloud." />

<div class="scroll">
  <div class="content">
    {#if form?.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}

    {#if data.registryError}
      <!-- Error ≠ empty: an outage must never read as "no devices paired". -->
      <RegistryErrorNotice />
    {:else if data.devices.length === 0}
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
                <span class="did mono">{device.id.slice(0, 18)}…</span>
              </div>
              <span class="os mono">{device.os ?? '—'}</span>
              <span class="seen mono" data-online={status.online}>
                {status.online ? 'online · now' : `offline · ${status.lastSeen}`}
              </span>
              <div class="revoke">
                {#if confirmingId === device.id}
                  <form
                    class="confirm"
                    method="POST"
                    action="?/revoke"
                    use:enhance={() => {
                      revokingId = device.id;
                      return async ({ update }) => {
                        await update();
                        revokingId = null;
                        confirmingId = null;
                      };
                    }}
                  >
                    <input type="hidden" name="deviceId" value={device.id} />
                    <button class="confirm-cancel" type="button" onclick={() => (confirmingId = null)}>
                      Cancel
                    </button>
                    <Button variant="danger" size="sm" type="submit" loading={revokingId === device.id}>
                      Revoke
                    </Button>
                  </form>
                {:else}
                  <button
                    class="revoke-btn"
                    type="button"
                    onclick={() => (confirmingId = device.id)}
                    aria-label="Revoke {device.name}"
                  >
                    Revoke
                  </button>
                {/if}
              </div>
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
    max-width: 56rem;
    padding: var(--space-6);
  }
  .error {
    margin: 0 0 var(--space-4);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-md);
    background: var(--danger-soft);
    color: var(--text);
    font-size: var(--text-sm);
  }
  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) 9rem 8.5rem auto;
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
  .os {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seen {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .seen[data-online='true'] {
    color: var(--text-secondary);
  }
  .revoke {
    justify-self: end;
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  /* The trigger reads as a quiet control that turns danger on intent (matches the panel's hairline rows). */
  .revoke-btn {
    padding: 5px var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }
  .revoke-btn:hover {
    color: var(--danger);
    border-color: var(--danger);
  }
  .revoke-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .confirm-cancel {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .confirm-cancel:hover {
    color: var(--text);
  }
  .confirm-cancel:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
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

  /* Drop the OS column first, then the presence column, as the rail/content narrows. */
  @media (max-width: 760px) {
    .row {
      grid-template-columns: 10px minmax(0, 1fr) 8.5rem auto;
    }
    .os {
      display: none;
    }
  }
  @media (max-width: 560px) {
    .row {
      grid-template-columns: 10px minmax(0, 1fr) auto;
    }
    .seen {
      display: none;
    }
    .content {
      padding: var(--space-4);
    }
  }
</style>
