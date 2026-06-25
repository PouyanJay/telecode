<script lang="ts">
  import { onMount } from 'svelte';

  import { env } from '$env/dynamic/public';
  import { goto } from '$app/navigation';
  import { Button, StatusDot } from '@telecode/ui';

  import TopBar from '$lib/components/TopBar.svelte';
  import { launchRepo } from '$lib/launch-repo';
  import { pushPermission, subscribeToPush, type PushState } from '$lib/push';
  import type { SessionState, SessionStatus } from '$lib/session';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import {
    connectionState,
    ensureConnection,
    launch,
    sessions as liveSessions,
  } from '$lib/session-store';
  import { statusPriority } from '$lib/sessions';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const RELAY_URL = env.PUBLIC_TELECODE_RELAY_URL ?? 'ws://127.0.0.1:8080/ws';

  const user = $derived(data.user);
  const device = $derived(data.devices[0] ?? null);
  const repos = $derived(data.repos);

  interface Row {
    id: string;
    title: string | null;
    status: SessionStatus;
    createdAt: Date;
  }

  // The persisted registry list (survives reloads) overlaid with live status from the channel; sessions
  // launched this visit but not yet in the registry are appended. Awaiting-input sorts loudest, to the top.
  const rows = $derived.by<Row[]>(() => {
    const byId = new Map<string, Row>();
    for (const s of data.sessions) {
      byId.set(s.id, { id: s.id, title: s.title, status: s.status, createdAt: s.createdAt });
    }
    for (const [id, state] of $liveSessions) {
      const existing = byId.get(id);
      const status = state.status === 'idle' ? (existing?.status ?? 'starting') : state.status;
      const title = existing?.title ?? firstPrompt(state.entries) ?? null;
      byId.set(id, { id, title, status, createdAt: existing?.createdAt ?? new Date() });
    }
    return [...byId.values()].sort(
      (a, b) =>
        statusPriority(a.status) - statusPriority(b.status) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  });

  function firstPrompt(entries: SessionState['entries']): string | undefined {
    return entries.find((e) => e.kind === 'user')?.text;
  }

  function relativeTime(date: Date): string {
    const mins = Math.round((Date.now() - date.getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }

  let prompt = $state('');
  let title = $state('');
  let selectedRepoId = $state('');
  let launching = $state(false);
  let launchError: string | null = $state(null);
  let pushState = $state<PushState>('unsupported');

  onMount(() => {
    pushState = pushPermission();
    if (device) {
      void ensureConnection({
        relayUrl: RELAY_URL,
        userId: user?.id ?? '',
        deviceId: device.id,
        daemonPublicKey: device.publicKey,
      });
    }
  });

  async function onEnableNotifications(): Promise<void> {
    pushState = await subscribeToPush(env.PUBLIC_VAPID_KEY ?? '');
  }

  async function onLaunch(event: Event): Promise<void> {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || launching || !device) return;
    launching = true;
    launchError = null;
    try {
      const repo = launchRepo(repos, selectedRepoId);
      const id = await launch({
        prompt: text,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(repo ? { repo } : {}),
      });
      await goto(`/sessions/${id}`);
    } catch (err) {
      launchError = err instanceof Error ? err.message : 'Launch failed.';
      launching = false;
    }
  }

  function onPromptKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void onLaunch(event);
  }
</script>

<svelte:head>
  <title>Sessions · telecode</title>
</svelte:head>

<TopBar {user} {device} connection={$connectionState} />

<main id="main" class="shell">
  {#if !device}
    <div class="empty">
      <p class="eyebrow">NO DEVICE PAIRED</p>
      <h1>Pair a device to begin</h1>
      <p class="sub">Run a daemon on your machine, then activate it here to launch and steer agents.</p>
      <p class="cta"><a href="/activate">Activate a device →</a></p>
    </div>
  {:else}
    <aside class="rail" aria-label="Devices">
      <p class="eyebrow">DEVICE</p>
      <ul class="devices">
        {#each data.devices as d (d.id)}
          <li class="device-item" class:active={d.id === device.id}>
            <StatusDot
              tone={$connectionState === 'connected' ? 'success' : 'muted'}
              label={d.name}
            />
          </li>
        {/each}
      </ul>
    </aside>

    <section class="body" aria-label="Sessions">
      {#if pushState === 'default'}
        <div class="notify hairline-b">
          <span class="notify-text">Get pinged when a session needs your input.</span>
          <Button variant="secondary" size="sm" onclick={onEnableNotifications}>
            Enable notifications
          </Button>
        </div>
      {:else if pushState === 'denied'}
        <div class="notify hairline-b">
          <span class="notify-text muted">Notifications are blocked in your browser settings.</span>
        </div>
      {/if}

      <form class="launch" onsubmit={onLaunch} aria-label="Launch a session">
        <p class="eyebrow">LAUNCH A SESSION ON {device.name}</p>
        {#if data.githubConnected && repos.length > 0}
          <label class="repo-field">
            <span class="field-label">Repository</span>
            <select class="repo" bind:value={selectedRepoId} aria-label="Repository">
              <option value="">No repo — run in the default workspace</option>
              {#each repos as repo (repo.id)}
                <option value={String(repo.id)}>{repo.fullName}{repo.private ? ' (private)' : ''}</option>
              {/each}
            </select>
          </label>
        {:else if data.githubConnected}
          <p class="repo-note">No repositories found for your GitHub account.</p>
        {:else}
          <p class="repo-note">
            Connect GitHub to run a session in one of your repos. The session runs in the daemon’s
            default workspace until then.
          </p>
        {/if}
        <textarea
          class="prompt"
          bind:value={prompt}
          onkeydown={onPromptKeydown}
          placeholder="Describe a task for the agent…"
          rows="2"
          aria-label="Task"
          aria-describedby="launch-hint"
        ></textarea>
        <div class="launch-row">
          <input
            class="title"
            bind:value={title}
            placeholder="Optional title…"
            aria-label="Session title"
            autocomplete="off"
          />
          <Button type="submit" variant="primary" size="lg" loading={launching}>Launch</Button>
        </div>
        {#if launchError}
          <span class="error" role="alert">{launchError}</span>
        {:else}
          <span id="launch-hint" class="hint">⌘↵ to launch. You’ll approve each consequential action.</span>
        {/if}
      </form>

      <div class="list-head hairline-b">
        <span class="band-label">SESSIONS</span>
        <span class="count">{rows.length}</span>
      </div>

      {#if rows.length === 0}
        <div class="list-empty">
          <p class="eyebrow">NO SESSIONS YET</p>
          <p class="sub">Launch one above to watch the agent work.</p>
        </div>
      {:else}
        <ul class="sessions" role="list">
          {#each rows as row (row.id)}
            {@const display = SESSION_DISPLAY[row.status]}
            <li>
              <a class="row hairline-b" href="/sessions/{row.id}">
                <StatusDot tone={display.tone} label={display.label} pulse={display.pulse} />
                <span class="row-title">{row.title ?? row.id}</span>
                <span class="row-time">{relativeTime(row.createdAt)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  .shell {
    height: calc(100dvh - 48px);
    display: grid;
    grid-template-columns: 1fr;
    min-height: 0;
  }
  @media (min-width: 720px) {
    .shell:has(.rail) {
      grid-template-columns: 13rem 1fr;
    }
  }

  /* No-device empty state */
  .empty {
    grid-column: 1 / -1;
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
  .cta {
    margin: var(--space-4) 0 0;
  }
  .cta a {
    color: var(--accent);
    font-weight: 500;
  }

  /* Device rail */
  .rail {
    display: none;
    padding: var(--space-5) var(--space-4);
    border-right: 1px solid var(--border);
    background: var(--surface);
    overflow-y: auto;
  }
  @media (min-width: 720px) {
    .rail {
      display: block;
    }
  }
  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .device-item {
    padding: var(--space-2);
    border-radius: var(--radius-md);
    border-left: 2px solid transparent;
  }
  .device-item.active {
    background: var(--accent-soft);
    border-left-color: var(--accent);
  }

  /* Body */
  .body {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .notify {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
  }
  .notify-text {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .notify-text.muted {
    color: var(--text-muted);
  }
  .launch {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
  }
  .prompt {
    width: 100%;
    min-height: 56px;
    max-height: 200px;
    resize: vertical;
    padding: var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: var(--lh-base);
  }
  .prompt:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* Repo picker */
  .repo-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .field-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .repo {
    width: 100%;
    height: 40px;
    padding: 0 var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .repo:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .repo-note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--lh-base);
  }
  .launch-row {
    display: flex;
    gap: var(--space-3);
    align-items: stretch;
  }
  .title {
    flex: 1;
    min-width: 0;
    height: 40px;
    padding: 0 var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 16px;
  }
  .title:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .hint {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .error {
    font-size: var(--text-xs);
    color: var(--danger);
  }

  /* Session list */
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
  }
  .band-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .list-empty {
    padding: var(--space-12) var(--space-4);
    text-align: center;
  }
  .sessions {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    color: var(--text);
    text-decoration: none;
  }
  .row:hover {
    background: var(--bg-muted);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .row-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }
  .row-time {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
