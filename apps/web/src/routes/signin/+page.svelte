<script lang="ts">
  import { enhance } from '$app/forms';
  import { BrandLogo, Button } from '@telecode/ui';

  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let submitting = $state<string | null>(null);
</script>

<svelte:head>
  <title>Sign in · telecode</title>
</svelte:head>

<main id="main" class="wrap">
  <section class="panel" aria-labelledby="signin-title">
    <div class="brand">
      <BrandLogo size={22} />
    </div>
    <p class="eyebrow">COMMAND CENTER</p>
    <h1 id="signin-title">Sign in</h1>
    <p class="sub">
      Launch, watch, and steer Claude Code agents on your own machine — from any browser.
    </p>

    {#if form?.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}

    {#if data.providers.length === 0}
      <p class="error" role="alert">
        No sign-in provider is configured on this server. Set <code>GITHUB_CLIENT_ID</code> and
        <code>GITHUB_CLIENT_SECRET</code> to enable GitHub sign-in.
      </p>
    {:else}
      <form
        method="POST"
        action="?/login"
        use:enhance={({ submitter }) => {
          submitting = submitter instanceof HTMLButtonElement ? submitter.value : null;
          return async ({ update }) => {
            await update();
            submitting = null;
          };
        }}
      >
        {#each data.providers as provider, i (provider.id)}
          <Button
            type="submit"
            name="provider"
            value={provider.id}
            variant={i === 0 ? 'primary' : 'secondary'}
            size="lg"
            loading={submitting === provider.id}
            disabled={submitting !== null}
          >
            {provider.label}
          </Button>
        {/each}
      </form>
    {/if}

    <p class="foot">Open-source · self-hostable · end-to-end encrypted</p>
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
    max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-top-color: var(--frame-top);
    border-radius: var(--radius-lg);
    padding: var(--space-8);
    box-shadow: var(--shadow-md);
  }
  .brand {
    margin-bottom: var(--space-8);
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
  .error {
    margin: 0 0 var(--space-4);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-md);
    background: var(--danger-soft);
    color: var(--text);
    font-size: var(--text-sm);
  }
  .error code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* The shared Button is inline-flex; make the sign-in actions full width. */
  form :global(button) {
    width: 100%;
  }
  .foot {
    margin: var(--space-8) 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
</style>
