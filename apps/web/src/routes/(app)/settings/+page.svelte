<script lang="ts">
  import { onMount } from 'svelte';

  import { enhance } from '$app/forms';
  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';
  import { Button, Panel } from '@telecode/ui';
  import type { PermissionModeName } from '@telecode/protocol';

  import PageHeader from '$lib/components/PageHeader.svelte';
  import PermissionModeField from '$lib/components/PermissionModeField.svelte';
  import { pushPermission, subscribeToPush, type PushState } from '$lib/push';
  import { DEFAULT_PERMISSION_MODE, readPermissionMode, writePermissionMode } from '$lib/settings';

  /**
   * Settings: the relay this dashboard talks to, the default launch permission mode (persisted, seeds the
   * launch drawer), web-push notifications, and account sign-out. Only real, wired controls are shown — the
   * relay endpoint is read-only (it's an env/self-host concern), and the mode is the conservative default.
   */
  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
  const VAPID_KEY = env.PUBLIC_VAPID_KEY ?? '';

  let mode = $state<PermissionModeName>(DEFAULT_PERMISSION_MODE);
  let pushState = $state<PushState>('unsupported');
  let enabling = $state(false);

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

  @media (max-width: 640px) {
    .content {
      padding: var(--space-4);
    }
  }
</style>
