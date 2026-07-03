<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { onMount } from 'svelte';

  import { enhance } from '$app/forms';
  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';
  import { Button, Panel, Switch } from '@telecode/ui';
  import type { PermissionModeName } from '@telecode/protocol';

  import { resolveAdoptSetupState } from '$lib/adopt-setup-state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PermissionModeField from '$lib/components/PermissionModeField.svelte';
  import { pushPermission, subscribeToPush, type PushState } from '$lib/push';
  import {
    adoptState,
    connectionState,
    requestAdoptConfig,
    setAdoptConfig,
  } from '$lib/session-store';
  import { DEFAULT_PERMISSION_MODE, readPermissionMode, writePermissionMode } from '$lib/settings';

  import type { ActionData, PageData } from './$types';

  /**
   * Settings: the relay this dashboard talks to, the default launch permission mode (persisted, seeds the
   * launch drawer), web-push notifications, account sign-out, and — for the operator only — the shared
   * deployment's scale-to-zero toggles. Only real, wired controls are shown.
   */
  let { data, form }: { data: PageData; form: ActionData } = $props();

  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
  const VAPID_KEY = env.PUBLIC_VAPID_KEY ?? '';

  let mode = $state<PermissionModeName>(DEFAULT_PERMISSION_MODE);
  let pushState = $state<PushState>('unsupported');
  let enabling = $state(false);

  // Operator infra (scale-to-zero) state. Prefer the latest action result, else the load. Null ⇒ the caller
  // isn't an operator (or the controls aren't configured) and the panel is hidden entirely.
  const infra = $derived(form && 'infra' in form && form.infra ? form.infra : data.infra);
  const webOn = $derived(infra?.webAlwaysOn ?? true);
  const relayOn = $derived(infra?.relayAlwaysOn ?? true);
  const scaleError = $derived(form && 'error' in form ? form.error : null);
  let pending = $state<null | 'web' | 'relay'>(null);

  // Mark the toggled service in-flight while the relay applies the cloud change (a few seconds), then clear
  // once the action result + reload land so the switch reflects what the cloud actually applied.
  function submitScale(target: 'web' | 'relay'): SubmitFunction {
    return () => {
      pending = target;
      return async ({ update }) => {
        await update();
        pending = null;
      };
    };
  }

  onMount(() => {
    mode = readPermissionMode(localStorage);
    pushState = pushPermission();
  });

  function persistMode(value: PermissionModeName): void {
    if (browser) writePermissionMode(localStorage, value);
  }

  async function enableNotifications(): Promise<void> {
    enabling = true;
    try {
      pushState = await subscribeToPush(VAPID_KEY);
    } finally {
      enabling = false;
    }
  }

  // Adopted-sessions policy (Journey 3): the daemon owns it; the web reads/writes it over the sealed
  // channel. Ask for the current policy once the channel is live; every edit sends the full new policy and
  // the UI reflects the daemon's confirmed reply (adoptState).
  let newDenyPath = $state('');
  const adoptConnected = $derived($connectionState === 'connected');

  $effect(() => {
    if (adoptConnected) requestAdoptConfig();
  });

  function toggleAdoption(): void {
    const state = $adoptState;
    if (state) setAdoptConfig({ enabled: !state.enabled, denylist: state.denylist });
  }
  function addDeny(): void {
    const state = $adoptState;
    const path = newDenyPath.trim();
    if (!state || path === '' || state.denylist.includes(path)) return;
    setAdoptConfig({ enabled: state.enabled, denylist: [...state.denylist, path] });
    newDenyPath = '';
  }
  function removeDeny(path: string): void {
    const state = $adoptState;
    if (state) {
      setAdoptConfig({ enabled: state.enabled, denylist: state.denylist.filter((p) => p !== path) });
    }
  }
</script>

<svelte:head>
  <title>Settings · telecode</title>
</svelte:head>

<PageHeader title="Settings" sub="Defaults for new sessions, notifications, and your relay." />

<div class="scroll">
  <div class="content">
    <Panel title="Relay & defaults" meta="applied to new sessions">
      <div class="body">
        <div class="field">
          <span class="label">Relay endpoint</span>
          <p class="readonly mono" title={RELAY_URL}>{RELAY_URL}</p>
          <p class="hint">Set <code class="mono">PUBLIC_TELECODE_RELAY_URL</code> to point at your own relay.</p>
        </div>

        <PermissionModeField bind:value={mode} onselect={persistMode} />

        <div class="field">
          <span class="label">Notifications</span>
          {#if pushState === 'granted'}
            <p class="status-on mono">On — you’ll be pinged when a session needs you.</p>
          {:else if pushState === 'denied'}
            <p class="hint">Blocked in your browser settings. Re-enable notifications for this site to turn them on.</p>
          {:else if pushState === 'unsupported'}
            <p class="hint">This browser can’t do web push. Install telecode to your home screen to enable it.</p>
          {:else}
            <p class="hint">Get pinged when a session is awaiting your input.</p>
            <div>
              <Button variant="secondary" size="sm" loading={enabling} onclick={enableNotifications}>
                Enable notifications
              </Button>
            </div>
          {/if}
        </div>
      </div>
    </Panel>

    <Panel title="Adopted sessions" meta="this device">
      <div class="body">
        <p class="hint">
          telecode monitors and steers the Claude Code sessions you start yourself (terminal or IDE). It sets
          this up automatically when you pair the device — nothing to install by hand.
        </p>

        {#if !$adoptState}
          <p class="hint">
            {adoptConnected
              ? 'Loading adoption settings…'
              : 'Connect this device to manage adoption.'}
          </p>
        {:else}
          {@const setupState = resolveAdoptSetupState($adoptState)}
          <div class="status" data-state={setupState} role="status">
            <span class="status-dot" aria-hidden="true"></span>
            <span class="status-label">
              {setupState === 'active'
                ? 'ACTIVE'
                : setupState === 'attention'
                  ? 'NOT INSTALLED'
                  : 'OFF'}
            </span>
            <span class="status-detail">
              {#if setupState === 'active'}
                Watching your sessions — {$adoptState.events.length} hook{$adoptState.events.length === 1
                  ? ''
                  : 's'} installed on this device.
              {:else if setupState === 'attention'}
                telecode couldn’t install its hooks — check that <code class="mono">~/.claude</code> is
                writable, then toggle adoption off and on.
              {:else}
                telecode isn’t touching your Claude Code config.
              {/if}
            </span>
          </div>

          <div class="toggle">
            <div class="toggle-text">
              <span class="toggle-label">Adopt my sessions</span>
              <p class="hint">
                When on, sessions you start are mirrored here — except the excluded projects below.
              </p>
            </div>
            <Switch
              checked={$adoptState.enabled}
              onclick={toggleAdoption}
              label="Adopt my Claude Code sessions"
            />
          </div>

          <div class="field">
            <span class="label">Excluded projects</span>
            <p class="hint">
              A session whose folder is one of these (or inside it) is never mirrored — it runs entirely on
              your machine.
            </p>
            {#if $adoptState.denylist.length === 0}
              <p class="hint">No exclusions — every project is adopted.</p>
            {:else}
              <ul class="denylist" role="list">
                {#each $adoptState.denylist as path (path)}
                  <li>
                    <code class="mono deny-path" title={path}>{path}</code>
                    <button
                      class="remove"
                      type="button"
                      onclick={() => removeDeny(path)}
                      aria-label={`Stop excluding ${path}`}
                    >
                      Remove
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            <form
              class="add"
              onsubmit={(e) => {
                e.preventDefault();
                addDeny();
              }}
            >
              <input
                class="deny-input mono"
                type="text"
                bind:value={newDenyPath}
                placeholder="/Users/you/private-repo"
                spellcheck="false"
                autocomplete="off"
                aria-label="Project path to exclude from adoption"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={newDenyPath.trim() === ''}>
                Add
              </Button>
            </form>
          </div>
        {/if}
      </div>
    </Panel>

    {#if infra}
      <Panel title="Infrastructure" meta="operator · affects everyone">
        <div class="body">
          <p class="hint">
            Keep a service always running, or let it scale to zero when idle to save cost. Turning one off
            adds a few-seconds cold start on the next request. These settings apply to the shared deployment
            for <strong>all</strong> users.
          </p>

          {#if scaleError}
            <p class="error mono" role="alert">{scaleError}</p>
          {/if}

          <div class="toggle">
            <div class="toggle-text">
              <span class="toggle-label">Web app always-on</span>
              <p class="hint">Off → the dashboard scales to zero when idle (cold start on first load).</p>
            </div>
            <form method="POST" action="?/setScale" use:enhance={submitScale('web')}>
              <input type="hidden" name="target" value="web" />
              <input type="hidden" name="alwaysOn" value={(!webOn).toString()} />
              <Switch
                type="submit"
                checked={webOn}
                loading={pending === 'web'}
                disabled={pending !== null}
                label="Keep web app always-on"
              />
            </form>
          </div>

          <div class="toggle">
            <div class="toggle-text">
              <span class="toggle-label">Relay always-on</span>
              <p class="hint">
                Off → the relay scales to zero when no device or browser is connected (cold start on
                reconnect).
              </p>
            </div>
            <form method="POST" action="?/setScale" use:enhance={submitScale('relay')}>
              <input type="hidden" name="target" value="relay" />
              <input type="hidden" name="alwaysOn" value={(!relayOn).toString()} />
              <Switch
                type="submit"
                checked={relayOn}
                loading={pending === 'relay'}
                disabled={pending !== null}
                label="Keep relay always-on"
              />
            </form>
          </div>
        </div>
      </Panel>
    {/if}

    <Panel title="Account">
      <div class="body">
        <form method="POST" action="/?/logout" use:enhance>
          <Button type="submit" variant="secondary" size="sm">Sign out</Button>
        </form>
      </div>
    </Panel>
  </div>
</div>

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .content {
    max-width: 44rem;
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .body {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  /* Setup status: a dot + UPPERCASE mono label (the house status convention), no saturated pill. */
  .status {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .status-dot {
    align-self: center;
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--text-muted);
  }
  .status[data-state='active'] .status-dot {
    background: var(--success);
  }
  .status[data-state='attention'] .status-dot {
    background: var(--warning);
  }
  .status-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-secondary);
  }
  .status[data-state='active'] .status-label {
    color: var(--success);
  }
  .status[data-state='attention'] .status-label {
    color: var(--warning);
  }
  .status-detail {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border: none;
    padding: 0;
    margin: 0;
  }
  .label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .readonly {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-muted);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--lh-sm);
  }
  .hint code,
  code.mono {
    font-size: 0.92em;
    padding: 1px var(--space-1);
    border-radius: var(--radius-sm);
    background: var(--bg-muted);
  }
  .status-on {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--success);
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .toggle-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .toggle-label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
  }
  .toggle form {
    margin: 0;
    flex: none;
  }
  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--danger);
  }
  .denylist {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .denylist li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-muted);
  }
  .deny-path {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    flex: none;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
  }
  .remove:hover {
    color: var(--danger);
  }
  .remove:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
  }
  .add {
    display: flex;
    gap: var(--space-2);
    margin: 0;
  }
  .deny-input {
    flex: 1;
    min-width: 0;
    /* 16px so iOS Safari doesn't auto-zoom the field on focus. */
    font-size: 1rem;
    color: var(--text);
    background: var(--bg-subtle);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }
  .deny-input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
  }

  @media (max-width: 640px) {
    .content {
      padding: var(--space-4);
    }
  }
</style>
