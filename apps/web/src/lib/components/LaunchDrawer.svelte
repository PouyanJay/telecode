<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { Button, Drawer } from '@telecode/ui';
  import type { PermissionModeName } from '@telecode/protocol';

  import PermissionModeField from '$lib/components/PermissionModeField.svelte';
  import { launchRepo } from '$lib/launch-repo';
  import type { RelayDevice, RelayRepo } from '$lib/server/relay-api';
  import { launch } from '$lib/session-store';
  import { DEFAULT_PERMISSION_MODE, readPermissionMode } from '$lib/settings';

  /**
   * The launch drawer (enterprise-ui §7 forms): pick where to run, an optional repo, the permission mode,
   * and the first instruction. Submit stays enabled until submission starts, then shows real pending
   * state — launch is verification-gated (the daemon must report the session started). Seeds the mode from
   * the saved Settings default each time it opens. Without a device it routes the operator to pairing
   * rather than presenting a form that can't run.
   */
  let {
    open = $bindable(false),
    device,
    repos,
    githubConnected,
  }: {
    open?: boolean;
    device: RelayDevice | null;
    repos: RelayRepo[];
    githubConnected: boolean;
  } = $props();

  let prompt = $state('');
  let title = $state('');
  let selectedRepoId = $state('');
  let mode = $state<PermissionModeName>(DEFAULT_PERMISSION_MODE);
  let launching = $state(false);
  let launchError = $state<string | null>(null);

  // Seed the mode from the saved default whenever the drawer opens (Settings owns the persisted value).
  $effect(() => {
    if (open && browser) mode = readPermissionMode(localStorage);
  });

  async function onLaunch(event: Event): Promise<void> {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || launching || !device) return;
    launching = true;
    launchError = null;
    try {
      const repo = launchRepo(repos, selectedRepoId);
      const id = await launch(
        {
          prompt: text,
          permissionMode: mode,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(repo ? { repo } : {}),
        },
        device.id,
      );
      open = false;
      prompt = '';
      title = '';
      await goto(`/sessions/${id}`);
    } catch (err) {
      launchError = err instanceof Error ? err.message : 'Launch failed.';
    } finally {
      launching = false;
    }
  }

  function onPromptKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void onLaunch(event);
  }
</script>

<Drawer bind:open title="Launch session">
  {#if !device}
    <div class="no-device">
      <p class="lede">No device is paired yet. Pair a machine to run agents on it.</p>
      <a class="link" href="/activate" onclick={() => (open = false)}>Pair a device →</a>
    </div>
  {:else}
    <form id="launch-form" class="form" onsubmit={onLaunch}>
      <div class="field">
        <span class="label">Run on</span>
        <p class="readonly mono" title={device.name}>{device.name}</p>
      </div>

      {#if githubConnected && repos.length > 0}
        <div class="field">
          <label class="label" for="launch-repo">Repository</label>
          <div class="select-wrap">
            <select id="launch-repo" class="select" bind:value={selectedRepoId}>
              <option value="">No repo — run in the default workspace</option>
              {#each repos as repo (repo.id)}
                <option value={String(repo.id)}>
                  {repo.fullName}{repo.private ? ' (private)' : ''}
                </option>
              {/each}
            </select>
            <svg class="chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5L6 7.5l3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </div>
        </div>
      {:else if githubConnected}
        <p class="note">No repositories found for your GitHub account.</p>
      {:else}
        <p class="note">
          Connect GitHub in Settings to run in one of your repos. The session runs in the daemon’s
          default workspace until then.
        </p>
      {/if}

      <PermissionModeField bind:value={mode} />

      <div class="field">
        <label class="label" for="launch-prompt">First instruction</label>
        <textarea
          id="launch-prompt"
          class="prompt"
          bind:value={prompt}
          onkeydown={onPromptKeydown}
          placeholder="Describe the task. Be specific about edge cases — fewer interruptions later…"
          rows="4"
          autocomplete="off"
          aria-keyshortcuts="Meta+Enter Control+Enter"
        ></textarea>
      </div>

      {#if launchError}
        <p class="error" role="alert">{launchError}</p>
      {/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    {#if device}
      <Button
        form="launch-form"
        type="submit"
        variant="primary"
        loading={launching}
        disabled={launching}
      >
        Launch on {device.name}
      </Button>
    {/if}
  {/snippet}
</Drawer>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border: none;
    padding: 0;
    margin: 0;
  }
  .label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .readonly {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-muted);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Styled native <select>: keeps full keyboard + type-ahead while replacing the default OS-chrome
     appearance with the token styling; color-scheme renders the open list dark. */
  .select-wrap {
    position: relative;
  }
  .select {
    width: 100%;
    height: 38px;
    padding: 0 var(--space-8) 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    color-scheme: dark;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    appearance: none;
    cursor: pointer;
  }
  .select:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .chevron {
    position: absolute;
    top: 50%;
    right: var(--space-3);
    width: 12px;
    height: 12px;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }

  .prompt {
    width: 100%;
    min-height: 96px;
    max-height: 240px;
    resize: vertical;
    padding: var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: var(--lh-base);
  }
  .prompt::placeholder {
    color: var(--text-muted);
  }
  .prompt:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--lh-base);
  }
  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--danger);
  }

  .no-device {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .lede {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-base);
    line-height: var(--lh-base);
  }
  .link {
    color: var(--accent);
    font-weight: 500;
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
  }
  .link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
</style>
