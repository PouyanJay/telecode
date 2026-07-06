<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button, ConfirmDialog, Panel, Pill } from '@telecode/ui';

  import DeviceRenameForm from '$lib/components/DeviceRenameForm.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import RegistryErrorNotice from '$lib/components/RegistryErrorNotice.svelte';
  import { deviceConsequences, revokeConsequenceText } from '$lib/device-consequences';
  import { deviceBoardHref, deviceBoardLinkText } from '$lib/device-filter';
  import { deviceChannelOf, deviceStatus } from '$lib/devices';
  import { pairingInstructions } from '$lib/pairing-instructions';
  import { deviceChannels, sessions as liveSessions } from '$lib/session-store';
  import type { SessionStatus } from '$lib/session';
  import type { ActionData, PageData } from './$types';

  /**
   * Paired devices — the machines that run agents on the user's behalf (never the cloud). Revoking is a
   * lifecycle: a click opens a confirmation dialog stating the real consequences (identity + how many
   * sessions end, and how many are waiting on the user right now); the form posts to the relay (owner-
   * scoped) and on success the row moves to the Revoked section below, where a Re-authorize flow explains
   * how to bring the same device — and its history — back.
   */
  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Live status per session id (the demuxed channels), overlaid on the registry for honest counts.
  const liveStatusById = $derived(
    new Map<string, SessionStatus>([...$liveSessions].map(([id, s]) => [id, s.status])),
  );

  // Each device row deep-links its filtered board ("6 sessions · 1 needs you →", plan B4): total
  // registry rows for the device + how many are blocked on the human (live status overlaid).
  const boardSummaryOf = $derived((deviceId: string): string => {
    const rows = data.sessions.filter((s) => s.deviceId === deviceId);
    const needsYou = rows.filter(
      (s) => (liveStatusById.get(s.id) ?? s.status) === 'awaiting_input',
    ).length;
    return deviceBoardLinkText(rows.length, needsYou);
  });

  let confirmOpen = $state(false);
  let confirming = $state<{ id: string; name: string } | null>(null);
  let revokingId = $state<string | null>(null);
  let reauthorizingId = $state<string | null>(null);

  function askRevoke(id: string, name: string): void {
    confirming = { id, name };
    confirmOpen = true;
  }

  const consequenceText = $derived.by(() => {
    if (!confirming) return '';
    return revokeConsequenceText(
      confirming.name,
      deviceConsequences(confirming.id, data.sessions, liveStatusById),
    );
  });

  let revokeForm = $state<HTMLFormElement | null>(null);

  function submitRevoke(): void {
    revokeForm?.requestSubmit();
  }
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
    {:else if data.devices.length === 0 && data.revokedDevices.length === 0}
      <div class="empty">
        <p class="eyebrow">No devices paired</p>
        <p class="sub">Pair a machine to run agents on it.</p>
        <a class="cta cta-primary" href="/activate">Pair a device</a>
      </div>
    {:else}
      {#if data.devices.length > 0}
        <Panel title="Paired devices" meta="{data.devices.length} total">
          <ul class="devices" role="list">
            {#each data.devices as device (device.id)}
              {@const channel = deviceChannelOf($deviceChannels, device.id)}
              {@const status = deviceStatus({
                lastSeenAt: device.lastSeenAt,
                connection: channel.connection,
                daemonOnline: channel.daemonOnline,
                restOnline: device.online,
              })}
              <li class="row hairline-b">
                <span class="dot" data-tone={status.tone} aria-hidden="true"></span>
                <div class="id">
                  <DeviceRenameForm deviceId={device.id} name={device.name} />
                  <span class="did mono">{device.id.slice(0, 18)}…</span>
                  <a class="board-link" href={deviceBoardHref(device.id)}>
                    {boardSummaryOf(device.id)}
                  </a>
                </div>
                <span class="os mono">{device.os ?? '—'}</span>
                <span class="seen mono" data-online={status.online}>
                  {status.online ? 'online · now' : `offline · ${status.lastSeen}`}
                </span>
                <div class="rowaction">
                  <button
                    class="row-btn row-btn-danger"
                    type="button"
                    onclick={() => askRevoke(device.id, device.name)}
                    aria-label="Revoke {device.name}"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        </Panel>
      {/if}

      {#if data.revokedError}
        <div class="revoked-outage"><RegistryErrorNotice /></div>
      {:else if data.revokedDevices.length > 0}
        <div class="section-gap">
          <Panel title="Revoked" meta="{data.revokedDevices.length} total">
            <ul class="devices" role="list">
              {#each data.revokedDevices as device (device.id)}
                <li class="row revoked-row hairline-b">
                  <Pill label="REVOKED" tone="danger" />
                  <div class="id">
                    <span class="name" title={device.name}>{device.name}</span>
                    <span class="did mono">
                      {device.sessionCount}
                      {device.sessionCount === 1 ? 'session' : 'sessions'} in history
                    </span>
                  </div>
                  <span class="os mono">{device.os ?? '—'}</span>
                  <div class="reauth-cell">
                    {#if device.pendingReauth}
                      <Pill label="AWAITING RE-AUTH" tone="warning" dot pulse />
                    {:else}
                      <button
                        class="row-btn"
                        type="button"
                        aria-expanded={reauthorizingId === device.id}
                        onclick={() =>
                          (reauthorizingId = reauthorizingId === device.id ? null : device.id)}
                      >
                        Re-authorize…
                      </button>
                    {/if}
                  </div>
                  {#if reauthorizingId === device.id}
                    <div class="reauth-help">
                      <p>
                        Run <code class="mono">{pairingInstructions.command}</code> on
                        <strong>{device.name}</strong>. It re-pairs to this same device — its history stays
                        attached.
                        {#if pairingInstructions.codeLocation}
                          Then enter the code from <code class="mono"
                            >{pairingInstructions.codeLocation}</code
                          >
                          on the
                        {:else}
                          Then enter the code it shows on the
                        {/if}
                        <a href="/activate">activation page</a>.
                      </p>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </Panel>
        </div>
      {/if}

      <div class="actions">
        <a class="cta cta-secondary" href="/activate">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M6.5 2.5v8M2.5 6.5h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          Pair a new device
        </a>
      </div>
    {/if}
  </div>
</div>

<!-- The revoke form is the submit target; the ConfirmDialog drives it so the network round-trip stays a
     real SvelteKit form action (progressive enhancement + owner-scoped on the relay). -->
<form
  bind:this={revokeForm}
  method="POST"
  action="?/revoke"
  class="visually-hidden"
  use:enhance={() => {
    revokingId = confirming?.id ?? null;
    return async ({ update }) => {
      await update();
      revokingId = null;
      confirmOpen = false;
      confirming = null;
    };
  }}
>
  <input type="hidden" name="deviceId" value={confirming?.id ?? ''} />
</form>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Revoke {confirming?.name ?? 'device'}?"
  body={consequenceText}
  confirmLabel="Revoke device"
  busy={revokingId !== null}
  onconfirm={submitRevoke}
  oncancel={() => (confirming = null)}
/>

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
  /* The revoked row swaps the presence dot/column for a REVOKED pill and gives the re-auth help a full
     row below, so it wraps to a two-line grid when expanded. */
  .revoked-row {
    grid-template-columns: auto minmax(0, 1fr) 9rem auto;
    row-gap: var(--space-3);
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
  .board-link {
    justify-self: start;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: var(--radius-sm);
    width: fit-content;
  }
  .board-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .board-link:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
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
  .rowaction,
  .reauth-cell {
    justify-self: end;
  }
  .reauth-help {
    grid-column: 1 / -1;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
  }
  .reauth-help p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
  }
  .reauth-help code {
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--bg-muted);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
  }
  .reauth-help a {
    color: var(--accent);
  }
  .section-gap {
    margin-top: var(--space-6);
  }
  .revoked-outage {
    margin-top: var(--space-6);
  }
  /* A quiet row-level control (matches the panel's hairline rows). The danger modifier turns the
     destructive Revoke trigger red on intent; the plain variant (Re-authorize) stays neutral. */
  .row-btn {
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
  .row-btn:hover {
    color: var(--text);
  }
  .row-btn-danger:hover {
    color: var(--danger);
    border-color: var(--danger);
  }
  .row-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
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

  /* Drop the OS column first, then the presence column, as the rail/content narrows. */
  @media (max-width: 760px) {
    .row {
      grid-template-columns: 10px minmax(0, 1fr) 8.5rem auto;
    }
    .revoked-row {
      grid-template-columns: auto minmax(0, 1fr) auto;
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
