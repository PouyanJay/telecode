<script lang="ts">
  import { Button, FieldNote } from '@telecode/ui';

  import { pullRequestUrl } from '$lib/open-pr';
  import { pushSessionBranch, type SessionPushOutcome } from '$lib/session-store';

  /**
   * The rail's Open-PR affordance (branch-actions T6, enterprise-ui states contract): one action
   * that pushes the session branch WITH THE LAPTOP'S OWN git credentials, then — because the push
   * verdict names the github.com repo — renders a REAL link to the PR page, opened by the user in
   * their own signed-in browser (never window.open from an async callback: popup blockers eat
   * those, and a link is the honest, accessible control anyway). Non-GitHub remotes still push;
   * the panel then says where the branch went instead of linking.
   */
  let { sessionId }: { sessionId: string } = $props();

  let busy = $state(false);
  let pushed = $state<Extract<SessionPushOutcome, { ok: true }> | null>(null);
  let error = $state<string | null>(null);

  const PUSH_STORIES: Record<Extract<SessionPushOutcome, { ok: false }>['reason'], string> = {
    'not-launched': 'Only telecode-launched sessions can push from here.',
    'mid-turn': 'A turn is running — push between turns.',
    'no-remote': 'The repo has no origin remote to push to.',
    auth: 'The device’s git credentials were refused. Check its SSH key or token.',
    rejected: 'The remote refused the branch (it moved on). Pull or rename, then retry.',
    timeout: 'The push did not finish in time. Nothing may have been published.',
    failed: 'The device could not push. Nothing was published.',
    'daemon-offline': 'The device went offline before it could push.',
    'no-connection': 'No connection to the session’s device.',
  };

  const prLink = $derived(
    pushed !== null && pushed.githubRepo !== undefined
      ? pullRequestUrl(pushed.githubRepo, pushed.branch, pushed.base)
      : null,
  );

  async function push(): Promise<void> {
    busy = true;
    error = null;
    const outcome = await pushSessionBranch(sessionId);
    busy = false;
    if (outcome.ok) {
      pushed = outcome;
      return;
    }
    error = PUSH_STORIES[outcome.reason];
  }
</script>

<div class="push-panel">
  {#if pushed === null}
    <Button variant="ghost" size="sm" loading={busy} onclick={push}>Push branch for a PR</Button>
  {:else if prLink !== null}
    <FieldNote>Pushed {pushed.branch}.</FieldNote>
    <a class="pr-link" href={prLink} target="_blank" rel="noopener noreferrer">
      Open a pull request on GitHub ↗
    </a>
  {:else}
    <FieldNote>Pushed {pushed.branch} to origin. Open a PR from your git host.</FieldNote>
  {/if}
  {#if error}
    <FieldNote tone="danger">{error}</FieldNote>
  {/if}
</div>

<style>
  .push-panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding-top: var(--space-2);
  }
  .pr-link {
    font-size: var(--text-sm);
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
    border-radius: var(--radius-sm);
  }
  .pr-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
