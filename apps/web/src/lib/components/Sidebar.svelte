<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/stores';
  import { BrandLogo, Button, Pill } from '@telecode/ui';

  import { deviceStatus } from '$lib/devices';
  import { isActive } from '$lib/nav';
  import type { RelayDevice } from '$lib/server/relay-api';
  import type { ConnectionState } from '$lib/session-store';

  /**
   * The persistent left rail (enterprise-ui §2): brand, the primary "Launch session" action, route-aware
   * navigation with the 2px amber active indicator, the paired-device list, and the account footer. Real
   * `<a href>` links so Cmd/middle-click and Back work. The device rows truncate long names with a
   * tooltip + show honest presence (the long-name defect this redesign fixes).
   */
  let {
    user,
    devices,
    connection,
    daemonOnline,
    sessionTotal,
    onlaunch,
  }: {
    user: { displayName?: string | null; email?: string | null } | null;
    devices: RelayDevice[];
    connection: ConnectionState;
    /** Whether the watched device's daemon is on the channel (null = no presence frame yet). */
    daemonOnline: boolean | null;
    sessionTotal: number;
    onlaunch: () => void;
  } = $props();

  const path = $derived($page.url.pathname);

  function initials(name: string | null | undefined, email: string | null | undefined): string {
    const source = (name ?? email ?? '?').trim();
    const parts = source.split(/\s+/).filter(Boolean);
    const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
    return letters.toUpperCase();
  }
</script>

<aside class="sidebar">
  <a class="brand" href="/" aria-label="telecode — sessions">
    <BrandLogo size={20} />
    <Pill label="beta" />
  </a>

  <div class="launch">
    <Button variant="primary" size="lg" onclick={onlaunch}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
      </svg>
      Launch session
      <kbd class="kbd">⌘N</kbd>
    </Button>
  </div>

  <nav class="nav" aria-label="Primary">
    <p class="eyebrow">Workspace</p>
    <a class="navlink" href="/" aria-current={isActive(path, '/') ? 'page' : undefined}>
      <svg class="nav-icon" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M2 4h11M2 7.5h11M2 11h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
      <span class="nav-label">Sessions</span>
      <span class="nav-count mono">{sessionTotal}</span>
    </a>
    <a class="navlink" href="/devices" aria-current={isActive(path, '/devices') ? 'page' : undefined}>
      <svg class="nav-icon" viewBox="0 0 15 15" fill="none" aria-hidden="true"><rect x="1.6" y="2.6" width="11.8" height="8" rx="1.3" stroke="currentColor" stroke-width="1.3" /><path d="M5.2 13h4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
      <span class="nav-label">Devices</span>
      <span class="nav-count mono">{devices.length}</span>
    </a>

    <p class="eyebrow">Account</p>
    <a class="navlink" href="/activate" aria-current={isActive(path, '/activate') ? 'page' : undefined}>
      <svg class="nav-icon" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M7.5 1.6l5 2.2v3.2c0 3-2.1 5-5 5.9-2.9-.9-5-2.9-5-5.9V3.8l5-2.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
      <span class="nav-label">Pair a device</span>
    </a>
    <a class="navlink" href="/settings" aria-current={isActive(path, '/settings') ? 'page' : undefined}>
      <svg class="nav-icon" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="7.5" cy="7.5" r="2.1" stroke="currentColor" stroke-width="1.3" /><path d="M7.5 1.4v2M7.5 11.6v2M13.6 7.5h-2M3.4 7.5h-2M11.8 3.2l-1.4 1.4M4.6 10.4l-1.4 1.4M11.8 11.8l-1.4-1.4M4.6 4.6L3.2 3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
      <span class="nav-label">Settings</span>
    </a>
  </nav>

  <div class="foot">
    {#if devices.length > 0}
      <ul class="devices" aria-label="Paired devices">
        {#each devices as device, i (device.id)}
          {@const status = deviceStatus({
            lastSeenAt: device.lastSeenAt,
            isWatched: i === 0,
            connection,
            daemonOnline,
          })}
          <li class="device">
            <span class="device-dot" data-tone={status.tone} aria-hidden="true"></span>
            <span class="device-name" title={device.name}>{device.name}</span>
            <span class="device-meta mono">{status.online ? 'online' : status.lastSeen}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="user">
      <span class="avatar mono" aria-hidden="true">{initials(user?.displayName, user?.email)}</span>
      <div class="who">
        <span class="name" title={user?.displayName ?? undefined}>{user?.displayName ?? 'Account'}</span>
        {#if user?.email}<span class="email mono" title={user.email}>{user.email}</span>{/if}
      </div>
      <form class="signout" method="POST" action="/?/logout" use:enhance>
        <Button type="submit" variant="ghost" size="sm">Sign out</Button>
      </form>
    </div>
  </div>
</aside>

<style>
  .sidebar {
    grid-row: 2;
    grid-column: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }
  /* The phone uses the bottom MobileNav instead; the rail would otherwise overlap the content cell. */
  @media (max-width: 640px) {
    .sidebar {
      display: none;
    }
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-4) var(--space-4);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .brand:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .launch {
    padding: 0 var(--space-3) var(--space-4);
  }
  /* The launch button keeps a stable, comfortable size — it fills a narrow rail but caps out, so it does
     NOT keep stretching as the sidebar is dragged wider; its kbd hint sits at the trailing edge. */
  .launch :global(.btn) {
    width: 100%;
    max-width: 14rem;
    justify-content: flex-start;
    gap: var(--space-2);
  }
  .kbd {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    opacity: 0.6;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 var(--space-2);
  }
  .eyebrow {
    margin: 0;
    padding: var(--space-3) var(--space-2) var(--space-1);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .navlink {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--text-sm);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .navlink:hover {
    background: var(--bg-muted);
    color: var(--text);
  }
  .navlink:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .navlink[aria-current='page'] {
    background: var(--bg-muted);
    color: var(--text);
  }
  /* The 2px amber active indicator (enterprise-ui §4). */
  .navlink[aria-current='page']::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 2px;
    height: 16px;
    border-radius: var(--radius-full);
    background: var(--accent);
  }
  .nav-icon {
    width: 15px;
    height: 15px;
    flex: none;
    color: var(--text-muted);
  }
  .navlink[aria-current='page'] .nav-icon {
    color: var(--accent);
  }
  .nav-label {
    flex: 1;
  }
  .nav-count {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .foot {
    margin-top: auto;
    border-top: 1px solid var(--border);
    padding: var(--space-3);
  }
  .devices {
    list-style: none;
    margin: 0 0 var(--space-2);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .device {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    min-width: 0;
  }
  .device-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--text-muted);
  }
  .device-dot[data-tone='success'] {
    background: var(--success);
  }
  .device-dot[data-tone='warning'] {
    background: var(--warning);
  }
  .device-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--text);
  }
  .device-meta {
    flex: none;
    font-size: 10px;
    color: var(--text-muted);
  }

  .user {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-1) var(--space-1);
    min-width: 0;
  }
  .avatar {
    width: 28px;
    height: 28px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-strong);
    background: var(--bg-muted);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .who {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .email {
    font-size: 10px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .signout {
    margin-left: auto;
    flex: none;
  }
</style>
