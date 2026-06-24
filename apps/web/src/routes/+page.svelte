<script lang="ts">
  import { onMount } from 'svelte';

  import { env } from '$env/dynamic/public';
  import { enhance } from '$app/forms';
  import { Button } from '@telecode/ui';

  import { createRelayConnection, type ConnectionStatus } from '$lib/relay-client';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';

  let status = $state<ConnectionStatus | 'idle'>('idle');
  const label = $derived(
    status === 'connected'
      ? 'CONNECTED'
      : status === 'connecting'
        ? 'CONNECTING…'
        : status === 'error'
          ? 'OFFLINE'
          : 'IDLE',
  );

  const user = $derived(data.user);

  onMount(() => {
    let conn: { close(): void } | null = null;
    void (async () => {
      try {
        const res = await fetch('/api/channel-token');
        if (!res.ok) {
          status = 'error';
          return;
        }
        const body = (await res.json()) as { channelToken: string };
        conn = createRelayConnection({
          relayUrl: RELAY_URL,
          userId: user?.id ?? '',
          deviceId: 'web',
          channelToken: body.channelToken,
          onStatus: (s) => (status = s),
        });
      } catch {
        status = 'error';
      }
    })();
    return () => conn?.close();
  });
</script>

<svelte:head>
  <title>telecode</title>
</svelte:head>

<header class="topbar hairline-b">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="name">telecode</span>
  </div>

  <div class="right">
    <span class="conn" data-status={status} aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span class="conn-label">{label}</span>
    </span>
    <span class="user" title={user?.email ?? undefined}>{user?.displayName ?? 'Account'}</span>
    <form method="POST" action="?/logout" use:enhance>
      <Button type="submit" variant="ghost" size="sm">Sign out</Button>
    </form>
  </div>
</header>

<main id="main" class="body">
  <div class="empty">
    <p class="eyebrow">SESSIONS</p>
    <h1>No sessions yet</h1>
    <p class="sub">
      Pair a device with <code>npx telecode</code>, then launch a session to watch an agent work here.
    </p>
    <p class="activate"><a href="/activate">Activate a device →</a></p>
  </div>
</main>

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
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
  }
  .mark {
    width: 11px;
    height: 11px;
    border-radius: var(--radius-sm);
    background: var(--accent);
  }
  .name {
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.06em;
    color: var(--text-secondary);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-full);
    background: var(--text-muted);
  }
  .conn[data-status='connected'] .dot {
    background: var(--success);
  }
  .conn[data-status='connecting'] .dot {
    background: var(--warning);
  }
  .conn[data-status='error'] .dot {
    background: var(--danger);
  }
  .user {
    color: var(--text-secondary);
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    display: grid;
    place-items: center;
    padding: var(--space-16) var(--space-4);
  }
  .empty {
    max-width: 30rem;
    text-align: center;
  }
  .eyebrow {
    margin: 0 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  h1 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xl);
    line-height: var(--lh-xl);
    font-weight: 600;
  }
  .sub {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-base);
    line-height: var(--lh-base);
  }
  code {
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 1px var(--space-1);
    border-radius: var(--radius-sm);
    background: var(--bg-muted);
    color: var(--text);
  }
  .activate {
    margin: var(--space-4) 0 0;
  }
  .activate a {
    color: var(--accent);
    font-weight: 500;
  }
</style>
