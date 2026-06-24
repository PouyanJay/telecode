<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@telecode/ui';

  import { pairingInstructions } from '$lib/pairing-instructions';

  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();
  let submitting = $state(false);
  // bind:value keeps the typed value across the enhance update (the component is not remounted),
  // so the field survives a failed submit without re-seeding from `form`.
  let code = $state('');
</script>

<svelte:head>
  <title>Activate a device · telecode</title>
</svelte:head>

<main id="main" class="wrap">
  <section class="panel" aria-labelledby="activate-title">
    <p class="eyebrow">PAIR A DEVICE</p>
    <h1 id="activate-title">Activate a device</h1>
    <p class="sub">
      {#if pairingInstructions.codeLocation}
        Run <code>{pairingInstructions.command}</code> on your machine, then enter the pairing code from
        <code>{pairingInstructions.codeLocation}</code> to bind it to your account.
      {:else}
        Run <code>{pairingInstructions.command}</code> on your machine, then enter the code it shows to bind
        it to your account.
      {/if}
    </p>

    {#if form?.activated}
      <p class="ok" role="status">Device activated. It will connect shortly — you can close this page.</p>
      <p class="back"><a href="/">Back to sessions</a></p>
    {:else}
      <form
        method="POST"
        use:enhance={() => {
          submitting = true;
          return async ({ update }) => {
            await update();
            submitting = false;
          };
        }}
      >
        <div class="field">
          <label class="label" for="code">Pairing code</label>
          <input
            id="code"
            name="code"
            class="code"
            bind:value={code}
            placeholder="ABCD-2345"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            aria-describedby={form?.error ? 'code-error' : 'code-hint'}
            aria-invalid={form?.error ? 'true' : undefined}
          />
          {#if form?.error}
            <span id="code-error" class="error" role="alert">{form.error}</span>
          {:else}
            <span id="code-hint" class="hint">Eight characters, e.g. ABCD-2345.</span>
          {/if}
        </div>

        <Button type="submit" variant="primary" size="lg" loading={submitting}>Activate device</Button>
      </form>
      <p class="back"><a href="/">Back to sessions</a></p>
    {/if}
  </section>
</main>

<style>
  .wrap {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: var(--space-6);
  }
  .panel {
    width: 100%;
    max-width: 400px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-top-color: var(--frame-top);
    border-radius: var(--radius-lg);
    padding: var(--space-8);
    box-shadow: var(--shadow-md);
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
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: 600;
  }
  .sub {
    margin: 0 0 var(--space-6);
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
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .label {
    font-weight: 500;
  }
  .code {
    height: 44px;
    padding: 0 var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 16px; /* ≥16px stops iOS Safari zoom-on-focus */
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .code:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .error {
    color: var(--danger);
    font-size: var(--text-xs);
  }
  .ok {
    margin: 0 0 var(--space-4);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--success);
    border-radius: var(--radius-md);
    background: var(--success-soft);
    color: var(--text);
    font-size: var(--text-sm);
  }
  form :global(button) {
    width: 100%;
  }
  .back {
    margin: var(--space-6) 0 0;
    text-align: center;
    font-size: var(--text-sm);
  }
  .back a {
    color: var(--text-secondary);
  }
</style>
