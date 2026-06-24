<script lang="ts">
  import { onMount } from 'svelte';

  import { env } from '$env/dynamic/public';
  import { StatusDot } from '@telecode/ui';

  import Composer from '$lib/components/Composer.svelte';
  import TopBar from '$lib/components/TopBar.svelte';
  import Transcript from '$lib/components/Transcript.svelte';
  import { initialSessionState, pendingPermission, type SessionState } from '$lib/session';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import {
    connectionState,
    decide,
    ensureConnection,
    sendUserMessage,
    sessions as liveSessions,
    subscribe,
  } from '$lib/session-store';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';
  // Reactive so navigating /sessions/A → /sessions/B (same route, no remount) re-targets + re-subscribes.
  const sessionId = $derived(data.sessionId);

  const user = $derived(data.user);
  const device = $derived(data.devices[0] ?? null);

  const known = $derived($liveSessions.has(sessionId));
  const session: SessionState = $derived($liveSessions.get(sessionId) ?? initialSessionState);

  const display = $derived(SESSION_DISPLAY[session.status]);
  const isBusy = $derived(
    session.status === 'starting' ||
      session.status === 'running' ||
      session.status === 'awaiting_input',
  );

  onMount(() => {
    if (device) {
      void ensureConnection({ relayUrl: RELAY_URL, userId: user?.id ?? '', deviceId: device.id });
    }
  });

  // Re-attach once the channel is live (and again after any reconnect): the daemon backfills the
  // transcript via session.history. Reopen is a reconnect, never a restart.
  $effect(() => {
    if ($connectionState === 'connected' && device) {
      subscribe(sessionId);
    }
  });

  function submitPrompt(text: string): void {
    sendUserMessage(sessionId, text);
  }

  function onDecide(behavior: 'allow' | 'deny'): void {
    const pending = pendingPermission(session);
    if (!pending || pending.kind !== 'permission') return;
    decide(
      sessionId,
      behavior === 'allow'
        ? { requestId: pending.requestId, behavior: 'allow' }
        : { requestId: pending.requestId, behavior: 'deny' },
    );
  }
</script>

<svelte:head>
  <title>Session · telecode</title>
</svelte:head>

<TopBar {user} {device} connection={$connectionState} />

<main id="main" class="view">
  <div class="band hairline-b">
    <a class="back" href="/">← Sessions</a>
    <span class="sid">{sessionId.slice(0, 8)}</span>
    <StatusDot tone={display.tone} label={display.label} pulse={display.pulse} aria-live="polite" />
  </div>

  {#if !known}
    <div class="placeholder">
      <p class="eyebrow">{$connectionState === 'error' ? 'OFFLINE' : 'RECONNECTING…'}</p>
      <p class="sub">
        {$connectionState === 'error'
          ? 'The channel is offline. It will restore when the connection returns.'
          : 'Restoring this session’s transcript.'}
      </p>
    </div>
  {:else}
    {#if session.entries.length === 0}
      <div class="placeholder">
        <p class="eyebrow">{display.label}</p>
        <p class="sub">No activity yet — send an instruction to steer this session.</p>
      </div>
    {:else}
      <Transcript
        entries={session.entries}
        onapprove={() => onDecide('allow')}
        onreject={() => onDecide('deny')}
      />
    {/if}
    <div class="dock hairline-t">
      <Composer
        {isBusy}
        submitLabel="Send"
        placeholder="Send a follow-up instruction…"
        onsend={submitPrompt}
      />
    </div>
  {/if}
</main>

<style>
  .view {
    height: calc(100dvh - 48px);
    width: 100%;
    max-width: var(--width-content);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .band {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--surface);
  }
  .back {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .back:hover {
    color: var(--text);
  }
  .back:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .sid {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-4);
    overflow-y: auto;
  }
  .eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .sub {
    margin: 0;
    max-width: 26rem;
    color: var(--text-secondary);
    font-size: var(--text-base);
    line-height: var(--lh-base);
  }
  .dock {
    padding: var(--space-3) var(--space-4);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
  }
</style>
