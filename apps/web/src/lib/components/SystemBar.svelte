<script lang="ts">
  import { BrandLogo, StatusDot } from '@telecode/ui';

  import type { Tone } from '$lib/session-display';
  import type { SessionCounts } from '$lib/session-groups';
  import type { ConnectionState } from '$lib/session-store';

  /**
   * The app-shell system bar (enterprise-ui §2): the honest relay-connection indicator, the standing
   * "end-to-end encrypted" assurance, and a live tally of working / blocked agents. It spans the full
   * width above the sidebar + content. On a phone (where the sidebar is hidden) it also carries the brand.
   * Connection + the awaiting count are `aria-live` so a status change is announced, not just recolored.
   */
  let {
    connection,
    counts,
  }: {
    connection: ConnectionState;
    counts: SessionCounts;
  } = $props();

  const RELAY: Record<ConnectionState, { tone: Tone; label: string; pulse: boolean }> = {
    idle: { tone: 'muted', label: 'Relay offline', pulse: false },
    connecting: { tone: 'warning', label: 'Connecting…', pulse: false },
    connected: { tone: 'success', label: 'Relay connected', pulse: true },
    error: { tone: 'danger', label: 'Relay offline', pulse: false },
  };
  const relay = $derived(RELAY[connection]);
  const agents = $derived(counts.running + counts.awaiting);
</script>

<header class="systembar hairline-b">
  <a class="brand" href="/" aria-label="telecode — sessions">
    <BrandLogo size={16} showWordmark={false} />
  </a>

  <span class="relay" aria-live="polite">
    <StatusDot tone={relay.tone} label={relay.label} pulse={relay.pulse} />
  </span>
  <span class="sep" aria-hidden="true">·</span>
  <span class="e2e mono">end-to-end encrypted</span>

  <div class="counts mono" aria-live="polite">
    <span>{agents} {agents === 1 ? 'agent' : 'agents'}</span>
    {#if counts.awaiting > 0}
      <span class="sep" aria-hidden="true">·</span>
      <span class="awaiting">{counts.awaiting} awaiting</span>
    {/if}
  </div>
</header>

<style>
  .systembar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: 36px;
    padding: 0 var(--space-4);
    background: var(--surface);
    border-top: 1px solid var(--frame-top);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  /* The mark only earns a slot in the bar on mobile; on desktop the sidebar carries the brand. */
  .brand {
    display: none;
    align-items: center;
    border-radius: var(--radius-sm);
  }
  .brand:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .relay {
    display: inline-flex;
  }
  .sep {
    color: var(--text-muted);
  }
  .e2e {
    color: var(--text-muted);
  }
  .counts {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-secondary);
  }
  .awaiting {
    color: var(--accent);
  }

  @media (max-width: 640px) {
    .brand {
      display: inline-flex;
    }
    .e2e,
    .systembar > .sep {
      display: none;
    }
  }
</style>
