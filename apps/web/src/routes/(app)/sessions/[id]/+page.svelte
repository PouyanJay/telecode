<script lang="ts">
  import {
    isSessionEndStatus,
    type QuestionAnswerItem,
    type SessionControlAction,
  } from '@telecode/protocol';
  import { ConfirmDialog } from '@telecode/ui';

  import { goto } from '$app/navigation';

  import Composer from '$lib/components/Composer.svelte';
  import InheritedContext from '$lib/components/InheritedContext.svelte';
  import LineageStrip from '$lib/components/LineageStrip.svelte';
  import SegmentDivider from '$lib/components/SegmentDivider.svelte';
  import SessionHeader from '$lib/components/SessionHeader.svelte';
  import SessionNotice from '$lib/components/SessionNotice.svelte';
  import SessionRail from '$lib/components/SessionRail.svelte';
  import Transcript from '$lib/components/Transcript.svelte';
  import { initialSessionState, type SessionState } from '$lib/session';
  import { firstRealPromptText } from '@telecode/protocol';
  import { pickDisplayTitle } from '$lib/session-groups';
  import { clockTime } from '$lib/clock-time';
  import { deviceChannelOf, deviceStatus } from '$lib/devices';
  import { lineageOf } from '$lib/lineage';
  import { segmentLabel } from '$lib/threads';
  import { resolveSessionDevice } from '$lib/session-device';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import { resolvePlaceholder, RESTORE_TIMEOUT_MS } from '$lib/session-placeholder';
  import { canResumeAsNew } from '$lib/resume-as-new';
  import {
    answer,
    answerHandover,
    archiveSession,
    connectionState,
    decide,
    deleteSessionForever,
    deviceChannels,
    renameSession,
    resetSessionTitle,
    resumeAsNew,
    sendControl,
    sendUserMessage,
    sessionDevices,
    sessionMetas,
    sessionTitleOverrides,
    sessions as liveSessions,
    subscribe,
  } from '$lib/session-store';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  // Reactive so navigating /sessions/A → /sessions/B (same route, no remount) re-targets + re-subscribes.
  const sessionId = $derived(data.sessionId);
  // The session's OWN device — its registry row, or the live routing map for a session launched
  // this visit (before its row lands). Null when its device was revoked or nothing routed it yet:
  // no name is better than a wrong name.
  const routedDeviceId = $derived(
    data.sessions.find((s) => s.id === sessionId)?.deviceId ??
      $sessionDevices.get(sessionId) ??
      null,
  );
  const device = $derived(
    resolveSessionDevice({
      sessionId,
      sessions: data.sessions,
      devices: data.devices,
      liveDeviceId: $sessionDevices.get(sessionId) ?? null,
    }),
  );
  // Honest placeholder facts (ux Phase 5): is the session's device revoked / online right now?
  const deviceRevoked = $derived(
    routedDeviceId !== null && !data.devices.some((d) => d.id === routedDeviceId),
  );
  const sessionDeviceOnline = $derived.by(() => {
    if (!device) return false;
    const channel = deviceChannelOf($deviceChannels, device.id);
    const rest = data.devices.find((d) => d.id === device.id)?.online ?? null;
    return deviceStatus({
      lastSeenAt: device.lastSeenAt,
      connection: channel.connection,
      daemonOnline: channel.daemonOnline,
      restOnline: rest,
    }).online;
  });

  const known = $derived($liveSessions.has(sessionId));
  const session: SessionState = $derived($liveSessions.get(sessionId) ?? initialSessionState);

  // The adopted-session "needs attention" notice is transient and dismissible; track the message the user
  // dismissed so it stays hidden until a NEW notice (different text) arrives.
  let dismissedNotice = $state<string | null>(null);
  const showNotice = $derived(session.notice !== null && session.notice !== dismissedNotice);
  // Same pattern for a delivery failure (relay.error): the user's action went nowhere — say so.
  let dismissedDeliveryError = $state<string | null>(null);
  const showDeliveryError = $derived(
    session.deliveryError !== null && session.deliveryError !== dismissedDeliveryError,
  );

  const display = $derived(SESSION_DISPLAY[session.status]);
  const isBusy = $derived(
    session.status === 'starting' ||
      session.status === 'running' ||
      session.status === 'awaiting_input',
  );
  // Operator controls (Task 9): interrupt stops the in-flight turn; end terminates it. Both need a live
  // channel, and nothing is actionable on a terminal session.
  const connected = $derived($connectionState === 'connected');
  // turn_limit is deliberately NOT terminal here: the controls stay (End can settle it for good)
  // and the composer continues the same conversation. needs_restart IS terminal — nothing to control.
  const isTerminal = $derived(
    session.status === 'done' || session.status === 'error' || session.status === 'needs_restart',
  );
  const showControls = $derived(known && session.status !== 'idle');
  // The session's name (header + browser tab): the user's rename override first (ux Phase 6 T6), then
  // decrypted metadata (survives reloads), then the first prompt seen this visit, then a short id prefix.
  const SESSION_ID_DISPLAY_LENGTH = 12;
  const sessionTitle = $derived(
    $sessionTitleOverrides.get(sessionId) ??
      pickDisplayTitle($sessionMetas.get(sessionId)?.title) ??
      firstRealPromptText(session.entries) ??
      sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH),
  );
  // A "Reset to default name" affordance appears only when the user has actually set an override.
  const hasTitleOverride = $derived($sessionTitleOverrides.has(sessionId));

  // Housekeeping (T7): Archive/Delete appear only for an ENDED, PERSISTED session. The effective
  // status prefers live frames but falls back to the registry row — a cold-loaded ended session whose
  // daemon is offline has no live status, yet must still be archivable.
  const registryRow = $derived(data.sessions.find((s) => s.id === sessionId));
  const effectiveStatus = $derived(
    known && session.status !== 'idle' ? session.status : registryRow?.status,
  );
  const canHousekeep = $derived(registryRow !== undefined && isSessionEndStatus(effectiveStatus));
  let confirmDeleteOpen = $state(false);
  let deleteBusy = $state(false);
  let archiveBusy = $state(false);
  let houseError = $state<string | null>(null);
  // The one irreversible action's consequence copy, derived here so the markup stays scannable.
  const deleteBody = $derived(
    'This permanently removes the session, its encrypted history, and its titles from your ' +
      `dashboard — on every device and browser. Files and code${device?.name ? ` on ${device.name}` : ' on your machine'} ` +
      'are not touched.',
  );

  async function onArchive(): Promise<void> {
    houseError = null;
    archiveBusy = true;
    const result = await archiveSession(sessionId);
    archiveBusy = false;
    if (!result.ok) {
      houseError = result.error;
      return;
    }
    // The row left the board's default list — return to the (re-loaded) board.
    await goto('/', { invalidateAll: true });
  }

  async function onDeleteConfirm(): Promise<void> {
    houseError = null;
    deleteBusy = true;
    const result = await deleteSessionForever(sessionId);
    deleteBusy = false;
    confirmDeleteOpen = false;
    if (!result.ok) {
      houseError = result.error;
      return;
    }
    await goto('/', { invalidateAll: true });
  }

  // A forked handover continuation links back to the adopted session it continues (Journey 4): live from
  // the daemon's session.chained, or from the persisted registry on a cold reload.
  const parentSessionId = $derived(
    session.parentSessionId ??
      data.sessions.find((s) => s.id === sessionId)?.parentSessionId ??
      null,
  );

  // The conversation's segments root→end (ux Phase 3, B2), from the persisted registry chain. Empty for
  // an unchained session — the strip and takeover divider render only for real chains.
  const lineage = $derived(lineageOf(sessionId, data.sessions));
  const entryCountOf = $derived(
    (id: string): number | null => $liveSessions.get(id)?.entries.length ?? null,
  );
  // The open session's neighbours in the chain: the segment it took over from (its transcript inlines
  // collapsed above the takeover divider) and the segment that superseded it (the forward pointer that
  // replaces "this session just ended").
  const currentIndex = $derived(lineage.findIndex((s) => s.isCurrent));
  const currentSegment = $derived(currentIndex >= 0 ? lineage[currentIndex] : undefined);
  const prevSegment = $derived(currentIndex > 0 ? lineage[currentIndex - 1] : undefined);
  const nextSegment = $derived(currentIndex >= 0 ? lineage[currentIndex + 1] : undefined);
  const inheritedEntries = $derived(
    prevSegment ? ($liveSessions.get(prevSegment.sessionId)?.entries ?? []) : [],
  );

  function onControl(action: SessionControlAction): void {
    sendControl(sessionId, action);
  }

  // Re-attach once the channel is live (and again after any reconnect): the daemon backfills the
  // transcript via session.history, and the relay replays its cached frames either way. Not gated on the
  // resolved device — a session whose device was revoked still deserves the cache replay, and without a
  // paired device no connection exists in the first place. Chained segments subscribe too, so the
  // lineage strip knows their sizes and the takeover divider can inline the inherited transcript.
  $effect(() => {
    if ($connectionState === 'connected') {
      subscribe(sessionId);
      for (const segment of lineage) {
        if (segment.sessionId !== sessionId) subscribe(segment.sessionId);
      }
    }
  });

  // Honest escalation: a healthy restore that stays silent past its deadline stops pretending.
  // The timer runs only while the placeholder is showing its RESTORING state (device online, no
  // transcript yet) and resets whenever those facts change.
  let restoreTimedOut = $state(false);
  $effect(() => {
    restoreTimedOut = false;
    if (known || !sessionDeviceOnline || $connectionState !== 'connected') return;
    const timer = setTimeout(() => (restoreTimedOut = true), RESTORE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  });

  const placeholder = $derived(
    resolvePlaceholder({
      relayState: $connectionState,
      deviceName: device?.name ?? null,
      deviceRevoked,
      deviceOnline: sessionDeviceOnline,
      timedOut: restoreTimedOut,
    }),
  );

  // Resume-as-new (T8): a session that CANNOT continue in place (needs_restart any origin; ended
  // adopted) routes its composer to a forked continuation instead of a dead-end follow-up.
  const resumeMode = $derived(
    effectiveStatus !== undefined &&
      canResumeAsNew(effectiveStatus, registryRow?.origin ?? 'launched'),
  );
  let resuming = $state(false);
  let resumeError = $state<string | null>(null);
  // Standing copy for the flipped composer, derived here so the markup stays scannable.
  const resumeNotice =
    'This session can’t continue here. Your next message starts a new linked session ' +
    'that picks up where it left off.';

  async function submitResumeAsNew(text: string): Promise<void> {
    resumeError = null;
    resuming = true;
    try {
      const childId = await resumeAsNew(sessionId, text);
      await goto(`/sessions/${childId}`, { invalidateAll: true });
    } catch (err) {
      resumeError = err instanceof Error ? err.message : 'Could not resume. Please try again.';
    } finally {
      resuming = false;
    }
  }

  function submitPrompt(text: string): void {
    if (resumeMode) {
      void submitResumeAsNew(text);
      return;
    }
    sendUserMessage(sessionId, text);
  }

  // Decide the SPECIFIC gate the operator clicked (its requestId), not "the first pending one". With
  // concurrent tool calls several gates can be open at once; resolving the first-pending would apply the
  // click to the wrong request — the operator clicks one gate and a different one resolves. Threading the
  // requestId (like onAnswer / onHandover already do) keeps each gate independently actionable.
  function onDecide(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    decide(
      sessionId,
      behavior === 'allow'
        ? { requestId, behavior: 'allow' }
        : // A rejection note rides the protocol's deny message — the agent reads it as guidance.
          { requestId, behavior: 'deny', ...(message !== undefined ? { message } : {}) },
    );
  }

  function onAnswer(requestId: string, answers: QuestionAnswerItem[]): void {
    answer(sessionId, { requestId, answers });
  }

  function onHandover(requestId: string, answerText: string): void {
    answerHandover(sessionId, { requestId, answerText });
  }

  // Actions on INHERITED entries route to the segment that owns them, not the open session.
  function actionsFor(targetSessionId: string) {
    return {
      onapprove: (requestId: string) => decide(targetSessionId, { requestId, behavior: 'allow' }),
      onreject: (requestId: string, message?: string) =>
        decide(targetSessionId, {
          requestId,
          behavior: 'deny',
          ...(message !== undefined ? { message } : {}),
        }),
      onanswer: (requestId: string, answers: QuestionAnswerItem[]) =>
        answer(targetSessionId, { requestId, answers }),
      onhandover: (requestId: string, answerText: string) =>
        answerHandover(targetSessionId, { requestId, answerText }),
    };
  }
</script>

<svelte:head>
  <title>{sessionTitle} · telecode</title>
</svelte:head>

<div class="view">
  <SessionHeader
    title={sessionTitle}
    deviceName={device?.name ?? null}
    cwd={$sessionMetas.get(sessionId)?.cwd ?? null}
    {sessionId}
    status={session.status}
    {isBusy}
    {isTerminal}
    {showControls}
    {connected}
    canReset={hasTitleOverride}
    {canHousekeep}
    houseBusy={archiveBusy}
    onrename={(title) => renameSession(sessionId, title)}
    onreset={() => resetSessionTitle(sessionId)}
    oninterrupt={() => onControl('interrupt')}
    onend={() => onControl('end')}
    onarchive={onArchive}
    ondelete={() => (confirmDeleteOpen = true)}
  />

  {#if houseError}
    <div class="house-error">
      <SessionNotice message={houseError} tone="danger" ondismiss={() => (houseError = null)} />
    </div>
  {/if}

  {#if lineage.length > 0}
    <LineageStrip segments={lineage} {entryCountOf} />
  {/if}

  <div class="body">
    <div class="stream-col">
      {#if lineage.length === 0 && parentSessionId}
        <!-- Fallback when the chain can't render (parent unknown to the registry, e.g. a fresh live
             fork): keep the plain link back rather than losing the relationship entirely. -->
        <a class="continued-from" href={`/sessions/${parentSessionId}`}>
          ← Continued from an adopted session
        </a>
      {/if}
      {#if known && showDeliveryError && session.deliveryError}
        <SessionNotice
          message={session.deliveryError}
          tone="danger"
          ondismiss={() => (dismissedDeliveryError = session.deliveryError)}
        />
      {/if}
      {#if known && showNotice && session.notice}
        <SessionNotice
          message={session.notice}
          ondismiss={() => (dismissedNotice = session.notice)}
        />
      {/if}
      {#if !known}
        <!-- The honest pre-transcript placeholder (ux Phase 5): names the actual blocker — relay
             down / device revoked / device offline (by name) — instead of spinning forever. -->
        <div class="placeholder">
          <p class="eyebrow">{placeholder.eyebrow}</p>
          <p class="sub">{placeholder.message}</p>
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
          onreject={(requestId, message) => onDecide(requestId, 'deny', message)}
          onanswer={onAnswer}
          onhandover={onHandover}
        >
          {#snippet lead()}
            {#if prevSegment && currentSegment}
              {#if inheritedEntries.length > 0}
                <InheritedContext
                  entries={inheritedEntries}
                  segmentName={segmentLabel(prevSegment.origin)}
                  {...actionsFor(prevSegment.sessionId)}
                />
              {/if}
              <SegmentDivider
                label={`Taken over in ${segmentLabel(currentSegment.origin)} · ${clockTime(currentSegment.startedAt)}`}
              />
            {/if}
          {/snippet}
          {#snippet tail()}
            {#if nextSegment}
              <SegmentDivider
                label={`Continued in ${segmentLabel(nextSegment.origin)} → open segment ${currentIndex + 2}`}
                href={`/sessions/${nextSegment.sessionId}`}
              />
            {/if}
          {/snippet}
        </Transcript>
      {/if}

      {#if known}
        <div class="dock hairline-t">
          {#if session.status === 'turn_limit' && !resumeMode}
            <!-- The honest affordance for a budget-exhausted run (B5): a pause, not a death. Standing
                 (no dismiss) — it reads for as long as the state does. -->
            <SessionNotice
              tone="warning"
              message="Turn limit reached — the run stopped early. Send a message to continue it."
            />
          {/if}
          {#if resumeMode}
            <!-- Resume-as-new (T8): the honest affordance for a session that CANNOT continue in
                 place. Standing (no dismiss) — it reads for as long as the state does. -->
            <SessionNotice tone="warning" message={resumeNotice} />
          {/if}
          {#if resumeError}
            <SessionNotice
              message={resumeError}
              tone="danger"
              ondismiss={() => (resumeError = null)}
            />
          {/if}
          <Composer
            isBusy={isBusy || resuming}
            submitLabel={resumeMode ? 'Resume as new' : 'Send'}
            placeholder={resumeMode
              ? 'Continue this work in a new session…'
              : 'Send a follow-up instruction…'}
            onsend={submitPrompt}
          />
        </div>
      {/if}
    </div>

    {#if known}
      <SessionRail
        {session}
        deviceName={device?.name ?? null}
        connection={$connectionState}
        meta={$sessionMetas.get(sessionId)}
      />
    {/if}
  </div>
</div>

<ConfirmDialog
  bind:open={confirmDeleteOpen}
  title="Delete this session?"
  body={deleteBody}
  confirmLabel="Delete session"
  confirmTone="danger"
  busy={deleteBusy}
  onconfirm={onDeleteConfirm}
/>

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
  .house-error {
    padding: var(--space-3) var(--space-4) 0;
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
