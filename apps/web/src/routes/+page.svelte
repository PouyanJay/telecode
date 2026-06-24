<script lang="ts">
  import { onMount } from 'svelte';

  import { env } from '$env/dynamic/public';
  import { enhance } from '$app/forms';
  import { Button, StatusDot } from '@telecode/ui';

  import Composer from '$lib/components/Composer.svelte';
  import Transcript from '$lib/components/Transcript.svelte';
  import { pairingInstructions } from '$lib/pairing-instructions';
  import { createRelayConnection } from '$lib/relay-client';
  import type { ConnectionStatus, RelayConnection } from '$lib/relay-client';
  import {
    appendUserMessage,
    applyEnvelope,
    initialSessionState,
    markDeciding,
    pendingPermission,
    startingState,
  } from '$lib/session';
  import type { SessionState, SessionStatus } from '$lib/session';
  import type { PageData } from './$types';

  type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted';
  type StatusDisplay = { tone: Tone; label: string; pulse: boolean };

  let { data }: { data: PageData } = $props();
  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';

  const user = $derived(data.user);
  // Phase 1 is single-device: watch the user's most recent paired device.
  const device = $derived(data.devices[0] ?? null);

  // Type annotations (not `$state<T>()` generics) — the latter trip the Svelte TS preprocessor.
  let connectionStatus: ConnectionStatus | 'idle' = $state('idle');
  let session: SessionState = $state(initialSessionState);
  let connection: RelayConnection | null = null;

  const CONN_DISPLAY: Record<ConnectionStatus | 'idle', { tone: Tone; label: string }> = {
    idle: { tone: 'muted', label: 'IDLE' },
    connecting: { tone: 'warning', label: 'CONNECTING…' },
    connected: { tone: 'success', label: 'CONNECTED' },
    error: { tone: 'danger', label: 'OFFLINE' },
  };
  const connDisplay = $derived(CONN_DISPLAY[connectionStatus]);

  const SESSION_DISPLAY: Record<SessionStatus, StatusDisplay> = {
    idle: { tone: 'muted', label: 'READY', pulse: false },
    starting: { tone: 'warning', label: 'STARTING…', pulse: false },
    running: { tone: 'accent', label: 'RUNNING', pulse: true },
    awaiting_input: { tone: 'accent', label: 'AWAITING INPUT', pulse: true },
    done: { tone: 'success', label: 'DONE', pulse: false },
    error: { tone: 'danger', label: 'ERROR', pulse: false },
    offline_paused: { tone: 'warning', label: 'OFFLINE', pulse: false },
  };
  const sessionDisplay = $derived(SESSION_DISPLAY[session.status]);
  const isBusy = $derived(
    session.status === 'starting' ||
      session.status === 'running' ||
      session.status === 'awaiting_input',
  );
  // Once a session is launched, the composer steers it with follow-ups; before that, it launches.
  const isFollowUp = $derived(session.sessionId !== null);
  const composerLabel = $derived(isFollowUp ? 'Send' : 'Launch');
  const composerPlaceholder = $derived(
    isFollowUp ? 'Send a follow-up instruction…' : 'Describe a task for the agent…',
  );

  onMount(() => {
    void (async () => {
      try {
        const res = await fetch('/api/channel-token');
        if (!res.ok) {
          connectionStatus = 'error';
          return;
        }
        const body = (await res.json()) as { channelToken: string };
        connection = createRelayConnection({
          relayUrl: RELAY_URL,
          userId: user?.id ?? '',
          // Without a paired device the browser still connects (proving relay reachability); it just
          // has no daemon channel to launch on until a device is activated.
          deviceId: device?.id ?? 'web',
          channelToken: body.channelToken,
          onStatus: (status) => (connectionStatus = status),
          onEvent: (envelope) => (session = applyEnvelope(session, envelope)),
        });
      } catch {
        connectionStatus = 'error';
      }
    })();
    return () => connection?.close();
  });

  /** Launch a new session, or — once one exists — send a follow-up to steer it. */
  function submitPrompt(text: string): void {
    if (!connection || !device) return;
    if (session.sessionId === null) {
      session = appendUserMessage(startingState(), text);
      connection.launch({ prompt: text });
    } else {
      const sessionId = session.sessionId;
      session = { ...appendUserMessage(session, text), status: 'running' };
      connection.sendUserMessage(sessionId, text);
    }
  }

  function decide(behavior: 'allow' | 'deny'): void {
    const pending = pendingPermission(session);
    if (!pending || pending.kind !== 'permission' || !connection || !session.sessionId) return;
    connection.decide(
      session.sessionId,
      behavior === 'allow'
        ? { requestId: pending.requestId, behavior: 'allow' }
        : { requestId: pending.requestId, behavior: 'deny' },
    );
    session = markDeciding(session, pending.requestId, behavior);
  }
</script>

<svelte:head>
  <title>telecode</title>
</svelte:head>

<header class="topbar hairline-b">
  <div class="bar-inner">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <span class="name">telecode</span>
      {#if device}
        <span class="sep" aria-hidden="true">/</span>
        <span class="device" title={device.name}>{device.name}</span>
      {/if}
    </div>

    <div class="right">
      <StatusDot tone={connDisplay.tone} label={connDisplay.label} aria-live="polite" />
      <span class="user" title={user?.email ?? undefined}>{user?.displayName ?? 'Account'}</span>
      <form method="POST" action="?/logout" use:enhance>
        <Button type="submit" variant="ghost" size="sm">Sign out</Button>
      </form>
    </div>
  </div>
</header>

<main id="main" class="body">
  {#if !device}
    <div class="empty">
      <p class="eyebrow">NO DEVICE PAIRED</p>
      <h1>Pair a device to begin</h1>
      <p class="sub">
        Run <code>{pairingInstructions.command}</code> on your machine, then activate it here to launch and
        steer agents.
      </p>
      <p class="activate"><a href="/activate">Activate a device →</a></p>
    </div>
  {:else}
    <section class="session" aria-label="Session">
      <div class="band hairline-b">
        <span class="band-label">SESSION</span>
        <StatusDot
          tone={sessionDisplay.tone}
          label={sessionDisplay.label}
          pulse={sessionDisplay.pulse}
          aria-live="polite"
        />
      </div>

      {#if session.entries.length === 0}
        <div class="ready">
          <p class="eyebrow">READY</p>
          <h1>Launch a session on {device.name}</h1>
          <p class="sub">
            Describe a task below. You’ll watch the agent work and approve each consequential action.
          </p>
        </div>
      {:else}
        <Transcript
          entries={session.entries}
          onapprove={() => decide('allow')}
          onreject={() => decide('deny')}
        />
      {/if}

      <Composer
        {isBusy}
        submitLabel={composerLabel}
        placeholder={composerPlaceholder}
        onsend={submitPrompt}
      />
    </section>
  {/if}
</main>

<style>
  .topbar {
    height: 48px;
    padding: 0 var(--space-4);
    background: var(--surface);
  }
  /* The bar spans full width (background + hairline), but its content aligns to the same
     centered column as the session console below it. */
  .bar-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: 100%;
    max-width: var(--width-content);
    margin-inline: auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
    min-width: 0;
  }
  .mark {
    width: 11px;
    height: 11px;
    flex: none;
    border-radius: var(--radius-sm);
    background: var(--accent);
  }
  .name {
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }
  .sep {
    color: var(--text-muted);
  }
  .device {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .user {
    color: var(--text-secondary);
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    /* Fill the viewport below the 48px top bar so the composer sticks to the bottom. */
    height: calc(100dvh - 48px);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* No-device empty state */
  .empty {
    margin: auto;
    max-width: 30rem;
    padding: var(--space-16) var(--space-4);
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

  /* Session view — a centered console column on wide screens (full-bleed on mobile), so the
     band, transcript, and composer align with each other instead of stretching edge to edge. */
  .session {
    width: 100%;
    max-width: var(--width-content);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  .band {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--surface);
  }
  .band-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .ready {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: var(--space-8) var(--space-4);
    overflow-y: auto;
  }
</style>
