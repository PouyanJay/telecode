<script lang="ts">
  import type { QuestionAnswerItem, SessionControlAction } from '@telecode/protocol';

  import Composer from '$lib/components/Composer.svelte';
  import SessionHeader from '$lib/components/SessionHeader.svelte';
  import SessionNotice from '$lib/components/SessionNotice.svelte';
  import SessionRail from '$lib/components/SessionRail.svelte';
  import Transcript from '$lib/components/Transcript.svelte';
  import { initialSessionState, type SessionState } from '$lib/session';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import {
    answer,
    answerHandover,
    connectionState,
    decide,
    sendControl,
    sendUserMessage,
    sessions as liveSessions,
    subscribe,
  } from '$lib/session-store';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  // Reactive so navigating /sessions/A → /sessions/B (same route, no remount) re-targets + re-subscribes.
  const sessionId = $derived(data.sessionId);
  const device = $derived(data.devices[0] ?? null);

  const known = $derived($liveSessions.has(sessionId));
  const session: SessionState = $derived($liveSessions.get(sessionId) ?? initialSessionState);

  // The adopted-session "needs attention" notice is transient and dismissible; track the message the user
  // dismissed so it stays hidden until a NEW notice (different text) arrives.
  let dismissedNotice = $state<string | null>(null);
  const showNotice = $derived(session.notice !== null && session.notice !== dismissedNotice);

  const display = $derived(SESSION_DISPLAY[session.status]);
  const isBusy = $derived(
    session.status === 'starting' ||
      session.status === 'running' ||
      session.status === 'awaiting_input',
  );
  // Operator controls (Task 9): interrupt stops the in-flight turn; end terminates it. Both need a live
  // channel, and nothing is actionable on a terminal session.
  const connected = $derived($connectionState === 'connected');
  const isTerminal = $derived(session.status === 'done' || session.status === 'error');
  const showControls = $derived(known && session.status !== 'idle');
  // The session's first prompt names it (in the header + browser tab); fall back to a short id prefix.
  const SESSION_ID_DISPLAY_LENGTH = 12;
  const sessionTitle = $derived(
    session.entries.find((e) => e.kind === 'user')?.text ??
      sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH),
  );

  // A forked handover continuation links back to the adopted session it continues (Journey 4): live from
  // the daemon's session.chained, or from the persisted registry on a cold reload.
  const parentSessionId = $derived(
    session.parentSessionId ??
      data.sessions.find((s) => s.id === sessionId)?.parentSessionId ??
      null,
  );

  function onControl(action: SessionControlAction): void {
    sendControl(sessionId, action);
  }

  // Re-attach once the channel is live (and again after any reconnect): the daemon backfills the
  // transcript via session.history. Reopen is a reconnect, never a restart. The shared connection itself
  // is opened by the app-shell layout.
  $effect(() => {
    if ($connectionState === 'connected' && device) {
      subscribe(sessionId);
    }
  });

  function submitPrompt(text: string): void {
    sendUserMessage(sessionId, text);
  }

  // Decide the SPECIFIC gate the operator clicked (its requestId), not "the first pending one". With
  // concurrent tool calls several gates can be open at once; resolving the first-pending would apply the
  // click to the wrong request — the operator clicks one gate and a different one resolves. Threading the
  // requestId (like onAnswer / onHandover already do) keeps each gate independently actionable.
  function onDecide(requestId: string, behavior: 'allow' | 'deny'): void {
    decide(
      sessionId,
      behavior === 'allow'
        ? { requestId, behavior: 'allow' }
        : { requestId, behavior: 'deny' },
    );
  }

  function onAnswer(requestId: string, answers: QuestionAnswerItem[]): void {
    answer(sessionId, { requestId, answers });
  }

  function onHandover(requestId: string, answerText: string): void {
    answerHandover(sessionId, { requestId, answerText });
  }
</script>

<svelte:head>
  <title>{sessionTitle} · telecode</title>
</svelte:head>

<div class="view">
  <SessionHeader
    title={sessionTitle}
    deviceName={device?.name ?? null}
    {sessionId}
    status={session.status}
    {isBusy}
    {isTerminal}
    {showControls}
    {connected}
    oninterrupt={() => onControl('interrupt')}
    onend={() => onControl('end')}
  />

  <div class="body">
    <div class="stream-col">
      {#if parentSessionId}
        <a class="continued-from" href={`/sessions/${parentSessionId}`}>
          ← Continued from an adopted session
        </a>
      {/if}
      {#if known && showNotice && session.notice}
        <SessionNotice
          message={session.notice}
          ondismiss={() => (dismissedNotice = session.notice)}
        />
      {/if}
      {#if !known}
        <div class="placeholder">
          <p class="eyebrow">{$connectionState === 'error' ? 'OFFLINE' : 'RECONNECTING…'}</p>
          <p class="sub">
            {$connectionState === 'error'
              ? 'The channel is offline. It will restore when the connection returns.'
              : 'Restoring this session’s transcript.'}
          </p>
        </div>
      {:else if session.entries.length === 0}
        <div class="placeholder">
          <p class="eyebrow">{display.label}</p>
          <p class="sub">No activity yet — send an instruction to steer this session.</p>
        </div>
      {:else}
        <Transcript
          entries={session.entries}
          offline={session.status === 'offline_paused'}
          onapprove={(requestId) => onDecide(requestId, 'allow')}
          onreject={(requestId) => onDecide(requestId, 'deny')}
          onanswer={onAnswer}
          onhandover={onHandover}
        />
      {/if}

      {#if known}
        <div class="dock hairline-t">
          <Composer
            isBusy={isBusy}
            submitLabel="Send"
            placeholder="Send a follow-up instruction…"
            onsend={submitPrompt}
          />
        </div>
      {/if}
    </div>

    {#if known}
      <SessionRail {session} deviceName={device?.name ?? null} connection={$connectionState} />
    {/if}
  </div>
</div>

<style>
  .view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
  }
  .stream-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .continued-from {
    align-self: flex-start;
    margin: var(--space-3) var(--space-4) 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .continued-from:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .continued-from:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring);
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
    text-transform: uppercase;
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

  /* Below the rail breakpoint the stream takes the full width; the rail is detail, not load-bearing. */
  @media (max-width: 900px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
    .body :global(.rail) {
      display: none;
    }
  }
</style>
