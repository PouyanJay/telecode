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
            {#if provider.id === 'github' && submitting !== provider.id}
              <svg
                class="provider-icon"
                viewBox="0 0 16 16"
                width="18"
                height="18"
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
            {/if}
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
  /* Provider mark sits inline before the label (Button supplies the gap); inherits the button
     text color via currentColor — dark on the amber primary, light on a secondary. */
  .provider-icon {
    flex: none;
  }
  .foot {
    margin: var(--space-8) 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
</style>
