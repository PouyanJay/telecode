<script lang="ts">
  import type { OnboardingStep } from '$lib/onboarding';

  /**
   * First-run onboarding (enterprise-ui §5, Phase 4 T14): the two-step path from a signed-in, unpaired
   * account to a first remote launch — pair a machine, then launch. The step model is the pure
   * `buildOnboardingSteps` ($lib/onboarding); this renders it as a numbered, instrument-style stepper with
   * the environment-aware daemon command (copyable) and a route to the pairing screen. Honest about the
   * trust model up front: the machine runs the agents and dials out — nothing reaches in.
   */
  let { steps }: { steps: readonly OnboardingStep[] } = $props();

  /** How long the "Copied" affordance stays up after a successful copy. */
  const CLIPBOARD_FEEDBACK_MS = 2000;

  // Verification-free, local affordance: copying a command is safe to be optimistic about.
  let copiedCommand = $state<string | null>(null);

  async function copy(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      copiedCommand = command;
      setTimeout(() => {
        if (copiedCommand === command) copiedCommand = null;
      }, CLIPBOARD_FEEDBACK_MS);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the command stays on screen to copy by hand.
    }
  }
</script>

<section class="onboarding" aria-label="Getting started">
  <p class="eyebrow">GET STARTED</p>
  <h1>Two steps to your first agent</h1>
  <p class="lede">
    Your machine runs the agents; this dashboard steers them. Nothing reaches into your laptop — it
    dials out to the relay, end-to-end encrypted.
  </p>

  <ol class="steps">
    {#each steps as step, i (step.key)}
      <li class="step" data-status={step.status}>
        <span class="marker" aria-hidden="true">{step.status === 'done' ? '✓' : i + 1}</span>
        <div class="content">
          <h2 class="title">{step.title}</h2>
          <p class="body">{step.body}</p>

          {#if step.key === 'pair' && step.command}
            <div class="terminal">
              <span class="prompt" aria-hidden="true">$</span>
              <code class="cmd">{step.command}</code>
              <button class="copy" type="button" onclick={() => copy(step.command ?? '')}>
                {copiedCommand === step.command ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span class="sr-only" role="status" aria-live="polite">
              {copiedCommand === step.command ? 'Command copied to clipboard' : ''}
            </span>
            <p class="note">
              {#if step.codeLocation}
                Read the pairing code from <code>{step.codeLocation}</code>.
              {:else}
                It prints a pairing code on screen.
              {/if}
            </p>
            {#if step.status === 'current'}
              <a class="cta" href="/activate">Enter pairing code →</a>
            {/if}
          {/if}
        </div>
      </li>
    {/each}
  </ol>
</section>

<style>
  .onboarding {
    margin-inline: auto;
    width: 100%;
    max-width: 34rem;
    padding: var(--space-12) var(--space-4);
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
  .lede {
    margin: 0 0 var(--space-8);
    color: var(--text-secondary);
    font-size: var(--text-base);
    line-height: var(--lh-base);
  }
  .steps {
    /* The marker diameter is a single component-internal constant the rail + columns derive from. */
    --marker-size: 28px;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .step {
    display: grid;
    grid-template-columns: var(--marker-size) 1fr;
    gap: var(--space-4);
    padding-bottom: var(--space-6);
    position: relative;
  }
  /* A hairline rail connects the step markers into a single instrument, not scattered cards. */
  .step:not(:last-child)::before {
    content: '';
    position: absolute;
    left: calc(var(--marker-size) / 2 - 0.5px);
    top: var(--marker-size);
    bottom: 0;
    width: 1px;
    background: var(--border);
  }
  .step:last-child {
    padding-bottom: 0;
  }
  .marker {
    z-index: 1;
    width: var(--marker-size);
    height: var(--marker-size);
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-strong);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .step[data-status='current'] .marker {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .step[data-status='done'] .marker {
    border-color: var(--success);
    color: var(--success);
  }
  .title {
    margin: var(--space-1) 0;
    font-size: var(--text-base);
    font-weight: 600;
  }
  .step[data-status='upcoming'] .title,
  .step[data-status='upcoming'] .body {
    color: var(--text-muted);
  }
  .body {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
  }
  .terminal {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .prompt {
    color: var(--accent);
    flex: none;
  }
  .cmd {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
    color: var(--text);
  }
  .copy {
    flex: none;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: color var(--dur-fast) var(--ease);
  }
  .copy:hover {
    color: var(--text);
    background: var(--bg-muted);
  }
  .copy:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .note {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--lh-base);
  }
  .note code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 1px var(--space-1);
    border-radius: var(--radius-sm);
    background: var(--bg-muted);
  }
  .cta {
    display: inline-block;
    margin-top: var(--space-3);
    color: var(--accent);
    font-weight: 500;
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
  }
  .cta:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  @media (prefers-reduced-motion: reduce) {
    .copy {
      transition: none;
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
