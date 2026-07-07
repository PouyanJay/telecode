<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { Button, Drawer } from '@telecode/ui';
  import { isValidGitBranchName, type PermissionModeName } from '@telecode/protocol';

  import PermissionModeField from '$lib/components/PermissionModeField.svelte';
  import { buildLaunchDeviceOptions, defaultLaunchDeviceId } from '$lib/launch-device';
  import { buildBranchPickerModel, type GithubBranchFetch } from '$lib/launch-branches';
  import { launchRepo } from '$lib/launch-repo';
  import type { RelayDevice, RelayRepo } from '$lib/server/relay-api';
  import {
    launch,
    repoBranches,
    requestRepoBranches,
    type DeviceChannelState,
  } from '$lib/session-store';
  import { DEFAULT_PERMISSION_MODE, readPermissionMode } from '$lib/settings';

  /**
   * The launch drawer (enterprise-ui §7 forms): pick where to run — a real device picker across the
   * fleet (ux Phase 5), with honest per-device presence — an optional repo, the permission mode, and
   * the first instruction. Submit stays enabled until submission starts, then shows real pending
   * state — launch is verification-gated (the daemon must report the session started). Seeds the mode
   * from the saved Settings default each time it opens. Without a device it routes the operator to
   * pairing rather than presenting a form that can't run.
   */
  let {
    open = $bindable(false),
    devices,
    channels,
    repos,
    githubConnected,
  }: {
    open?: boolean;
    devices: RelayDevice[];
    /** Per-device channel state from the pool — presence for the picker's ●/○ marks. */
    channels: ReadonlyMap<string, DeviceChannelState>;
    repos: RelayRepo[];
    githubConnected: boolean;
  } = $props();

  let prompt = $state('');
  let title = $state('');
  let selectedRepoId = $state('');
  let selectedDeviceId = $state('');
  let mode = $state<PermissionModeName>(DEFAULT_PERMISSION_MODE);
  let launching = $state(false);
  let launchError = $state<string | null>(null);
  // Branch control (Phase B): which base to cut from + an optional custom session-branch name.
  let baseBranch = $state('');
  let branchName = $state('');
  let githubFetch = $state<GithubBranchFetch>({ state: 'idle', branches: [] });

  const deviceOptions = $derived(buildLaunchDeviceOptions(devices, channels));
  const selectedDevice = $derived(
    deviceOptions.find((option) => option.id === selectedDeviceId) ?? null,
  );

  // Seed the mode from the saved default whenever the drawer opens (Settings owns the persisted value).
  $effect(() => {
    if (open && browser) mode = readPermissionMode(localStorage);
  });

  // Keep a valid launch target: seed the default on open, and re-seed only if the picked device
  // left the fleet (a mid-open revoke) — never stomp a choice the operator has made.
  $effect(() => {
    if (!open) return;
    if (!deviceOptions.some((option) => option.id === selectedDeviceId)) {
      selectedDeviceId = defaultLaunchDeviceId(deviceOptions) ?? '';
    }
  });

  const selectedRepo = $derived(
    repos.find((repo) => String(repo.id) === selectedRepoId) ?? null,
  );

  // Fetch the selected GitHub repo's branches (relay-proxied); "no repo" asks the launch device's
  // daemon for its default repo's branches over the sealed round-trip instead.
  $effect(() => {
    if (!open || !browser) return;
    const repo = selectedRepo;
    if (repo === null) {
      githubFetch = { state: 'idle', branches: [] };
      if (selectedDeviceId) requestRepoBranches(selectedDeviceId);
      return;
    }
    const aborter = new AbortController();
    githubFetch = { state: 'loading', branches: [] };
    void fetch(
      `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches`,
      { signal: aborter.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error('branch listing failed');
        const body = (await res.json()) as { branches: string[] };
        githubFetch = { state: 'loaded', branches: body.branches };
      })
      .catch(() => {
        // An abort means the selection moved on — the next effect run owns the state.
        if (!aborter.signal.aborted) githubFetch = { state: 'error', branches: [] };
      });
    return () => {
      aborter.abort();
    };
  });

  const picker = $derived(
    buildBranchPickerModel({
      repo: selectedRepo,
      github: githubFetch,
      local: $repoBranches.get(selectedDeviceId),
    }),
  );

  // Pre-select the source's default whenever the picker (re)becomes ready; keep an operator's pick
  // only while it remains a real option of the CURRENT source.
  $effect(() => {
    if (picker.status !== 'ready') return;
    if (!picker.branches.includes(baseBranch)) {
      baseBranch = picker.defaultBranch ?? picker.branches[0] ?? '';
    }
  });

  const branchNameInvalid = $derived(
    branchName.trim() !== '' && !isValidGitBranchName(branchName.trim()),
  );

  async function onLaunch(event: Event): Promise<void> {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || launching || !selectedDevice || branchNameInvalid) return;
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
          ...(picker.status === 'ready' && baseBranch !== '' ? { baseBranch } : {}),
          ...(branchName.trim() !== '' ? { branchName: branchName.trim() } : {}),
        },
        selectedDevice.id,
      );
      open = false;
      prompt = '';
      title = '';
      branchName = '';
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

{#snippet chevron()}
  <svg class="chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5L6 7.5l3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
{/snippet}

<Drawer bind:open title="Launch session">
  {#if deviceOptions.length === 0}
    <div class="no-device">
      <p class="lede">No device is paired yet. Pair a machine to run agents on it.</p>
      <a class="link" href="/activate" onclick={() => (open = false)}>Pair a device →</a>
    </div>
  {:else}
    <form id="launch-form" class="form" onsubmit={onLaunch}>
      {#if deviceOptions.length === 1}
        <div class="field">
          <span class="label">Run on</span>
          <p class="readonly mono" title={deviceOptions[0]!.name}>
            {deviceOptions[0]!.online ? '●' : '○'}
            {deviceOptions[0]!.name}
          </p>
        </div>
      {:else}
        <div class="field">
          <label class="label" for="launch-device">Run on</label>
          <div class="select-wrap">
            <select id="launch-device" class="select" bind:value={selectedDeviceId}>
              {#each deviceOptions as option (option.id)}
                <option value={option.id}>
                  {option.online ? '●' : '○'}
                  {option.name}{option.online ? '' : ' (offline)'}
                </option>
              {/each}
            </select>
            {@render chevron()}
          </div>
          {#if selectedDevice && !selectedDevice.online}
            <p class="note">
              {selectedDevice.name} is offline — the launch will fail until it reconnects.
            </p>
          {/if}
        </div>
      {/if}

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
            {@render chevron()}
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

      {#if picker.status === 'loading'}
        <p class="note" role="status">Loading branches…</p>
      {:else if picker.status === 'error'}
        <p class="note note-error" role="status">
          Couldn’t list branches — the session will start from the repo’s default.
        </p>
      {:else if picker.status === 'ready'}
        <div class="field">
          <label class="label" for="launch-base">Base branch</label>
          <div class="select-wrap">
            <select id="launch-base" class="select" bind:value={baseBranch}>
              {#each picker.branches as branch (branch)}
                <option value={branch}>{branch}</option>
              {/each}
            </select>
            {@render chevron()}
          </div>
          <p class="hint">The session works on its own new branch, cut from this one.</p>
        </div>
      {/if}

      <div class="field">
        <label class="label" for="launch-branch-name">
          New branch name <span class="optional">optional</span>
        </label>
        <input
          id="launch-branch-name"
          class="input"
          type="text"
          bind:value={branchName}
          placeholder="auto: telecode/task-slug-id"
          autocomplete="off"
          spellcheck="false"
          aria-invalid={branchNameInvalid}
          aria-describedby={branchNameInvalid ? 'launch-branch-name-error' : undefined}
        />
        {#if branchNameInvalid}
          <p class="hint hint-error" id="launch-branch-name-error">
            Not a valid git branch name (no spaces, “..”, or a leading “-”).
          </p>
        {/if}
      </div>

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
    {#if selectedDevice}
      <Button
        form="launch-form"
        type="submit"
        variant="primary"
        loading={launching}
        disabled={launching}
      >
        Launch on {selectedDevice.name}
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
  .note-error {
    color: var(--danger);
  }
  /* The custom branch-name input: same control chrome as .select, mono because it is machine data. */
  .input {
    width: 100%;
    height: 38px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .input::placeholder {
    color: var(--text-muted);
  }
  .input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .input[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .hint {
    margin: var(--space-1) 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--lh-xs);
  }
  .hint-error {
    color: var(--danger);
  }
  .optional {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-left: var(--space-1);
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
