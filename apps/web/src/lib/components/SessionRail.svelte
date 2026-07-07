<script lang="ts">
  import type { SessionChangesPayload, SessionMetaPayload } from '@telecode/protocol';

  import { changesView } from '$lib/changes';
  import { SESSION_DISPLAY } from '$lib/session-display';
  import type { SessionState } from '$lib/session';
  import type { ConnectionState } from '$lib/session-store';

  /**
   * The session-view right rail (enterprise-ui §7): durable facts about the run. "Session" and
   * "Connection" are true invariants (the daemon dials out over WSS, E2E via x25519, the relay forwards
   * ciphertext only). "Changes" renders {@link changesView}: the daemon's sealed branch-diff vs the
   * session's base when one exists (launched sessions, Phase C), else the approval-gate record — real
   * counts from real sources, never invented totals. Collapses below the stream on a phone.
   */
  let {
    session,
    deviceName,
    connection,
    meta,
    changes,
  }: {
    session: SessionState;
    deviceName: string | null;
    connection: ConnectionState;
    /** Decrypted session metadata (ux Phase 6): model, working directory, and git branch. */
    meta?: SessionMetaPayload | undefined;
    /** Decrypted branch-diff summary (Phase C); absent → the gate-derived fallback renders. */
    changes?: SessionChangesPayload | undefined;
  } = $props();

  const display = $derived(SESSION_DISPLAY[session.status]);
  const view = $derived(changesView(changes, session.entries));
  const online = $derived(connection === 'connected');

  /** ±counts render honestly: a null count (binary/untracked file) is "—", never a fake 0. */
  const stat = (prefix: '+' | '−', count: number | null): string =>
    count === null ? '—' : `${prefix}${count}`;
</script>

<aside class="rail" aria-label="Session details">
  <section class="rsec">
    <p class="eyebrow">Session</p>
    <div class="meta hairline-b">
      <span class="meta-key">Status</span>
      <span class="meta-val mono" class:amber={display.tone === 'accent'}>{display.label}</span>
    </div>
    {#if deviceName}
      <div class="meta hairline-b">
        <span class="meta-key">Device</span>
        <span class="meta-val mono">{deviceName}</span>
      </div>
    {/if}
    {#if meta?.model}
      <div class="meta hairline-b">
        <span class="meta-key">Model</span>
        <span class="meta-val mono">{meta.model}</span>
      </div>
    {/if}
    {#if meta?.cwd}
      <div class="meta hairline-b">
        <span class="meta-key">Directory</span>
        <span class="meta-val mono" title={meta.cwd}>{meta.cwd}</span>
      </div>
    {/if}
    {#if meta?.branch}
      <div class="meta hairline-b">
        <span class="meta-key">Branch</span>
        <span class="meta-val mono" title={meta.branch}>{meta.branch}</span>
      </div>
    {/if}
    <div class="meta">
      <span class="meta-key">Session</span>
      <span class="meta-val mono">{session.sessionId?.slice(0, 14) ?? '—'}</span>
    </div>
  </section>

  <section class="rsec">
    <div class="rh">
      <span class="eyebrow">
        Changes{#if view.baseBranch}<span class="vsbase mono" title={`diff vs ${view.baseBranch}`}>
            vs {view.baseBranch}</span
          >{/if}
      </span>
      {#if view.files.length > 0}
        <span class="totals mono">
          <span class="add">+{view.additions}</span>
          <span class="del">−{view.deletions}</span>
        </span>
      {/if}
    </div>
    {#if view.files.length === 0}
      <p class="muted">No file changes yet.</p>
    {:else}
      {#each view.files as file (file.path)}
        <div class="meta hairline-b file">
          <span class="fname mono" title={file.path}>{file.path}</span>
          <span class="fstat mono">
            <span class="add">{stat('+', file.additions)}</span>
            <span class="del">{stat('−', file.deletions)}</span>
          </span>
        </div>
      {/each}
      {#if view.truncated}
        <p class="pending mono">list truncated · totals cover the full diff</p>
      {/if}
      {#if view.pending > 0}
        <p class="pending mono">{view.pending} pending · not yet written to disk</p>
      {/if}
    {/if}
  </section>

  <section class="rsec">
    <p class="eyebrow">Connection</p>
    <div class="meta hairline-b">
      <span class="meta-key">Transport</span>
      <span class="meta-val mono">{online ? 'WSS · outbound' : 'offline'}</span>
    </div>
    <div class="meta hairline-b">
      <span class="meta-key">Encryption</span>
      <span class="meta-val mono">x25519 · e2e</span>
    </div>
    <div class="meta">
      <span class="meta-key">Relay sees</span>
      <span class="meta-val mono">ciphertext</span>
    </div>
  </section>
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-5);
    overflow-y: auto;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }
  .rsec {
    display: flex;
    flex-direction: column;
  }
  .eyebrow {
    margin: 0 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .rh {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .rh .eyebrow {
    margin: 0;
  }
  .vsbase {
    margin-left: var(--space-2);
    text-transform: none;
    letter-spacing: normal;
    color: var(--text-secondary);
  }
  .totals {
    display: flex;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }
  .meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    font-size: var(--text-sm);
  }
  .meta-key {
    color: var(--text-muted);
    flex: none;
  }
  .meta-val {
    font-size: var(--text-xs);
    color: var(--text);
    text-align: right;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta-val.amber {
    color: var(--accent);
  }
  .file .fname {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .fstat {
    display: flex;
    gap: var(--space-2);
    flex: none;
    font-size: var(--text-xs);
  }
  .add {
    color: var(--success);
  }
  .del {
    color: var(--danger);
  }
  .muted {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .pending {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
