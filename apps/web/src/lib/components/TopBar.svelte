<script lang="ts">
  import { enhance } from '$app/forms';
  import { BrandLogo, Button, StatusDot } from '@telecode/ui';

  import type { Tone } from '$lib/session-display';
  import type { ConnectionState } from '$lib/session-store';

  /**
   * The app-shell top bar (enterprise-ui §2): brand → home, the device being watched, the honest
   * connection indicator, and the account + sign-out. Shared by the dashboard and the session view so
   * navigation chrome stays identical across routes. Sign-out posts to the root route's `logout` action.
   */

  let {
    user,
    device = null,
    connection,
  }: {
    user: { displayName?: string | null; email?: string | null } | null;
    device?: { name: string } | null;
    connection: ConnectionState;
  } = $props();

  const CONN: Record<ConnectionState, { tone: Tone; label: string }> = {
    idle: { tone: 'muted', label: 'IDLE' },
    connecting: { tone: 'warning', label: 'CONNECTING…' },
    connected: { tone: 'success', label: 'CONNECTED' },
    error: { tone: 'danger', label: 'OFFLINE' },
  };
  const conn = $derived(CONN[connection]);
</script>

<header class="topbar hairline-b">
  <a class="brand" href="/">
    <BrandLogo size={18} />
  </a>

  <div class="right">
    {#if device}
      <span class="device" title={device.name}>{device.name}</span>
      <span class="sep" aria-hidden="true"></span>
    {/if}
    <StatusDot tone={conn.tone} label={conn.label} aria-live="polite" />
    <span class="user" title={user?.email ?? undefined}>{user?.displayName ?? 'Account'}</span>
    <form method="POST" action="/?/logout" use:enhance>
      <Button type="submit" variant="ghost" size="sm">Sign out</Button>
    </form>
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: 48px;
    padding: 0 var(--space-4);
    background: var(--surface);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .brand:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .device {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 14rem;
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--border-strong);
  }
  .user {
    color: var(--text-secondary);
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
