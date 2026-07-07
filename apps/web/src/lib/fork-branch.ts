import type { RepoBranchesStatePayload } from '@telecode/protocol';

/**
 * The base choices a fork-onto-branch picker offers (branch-actions T5): the parent's own branch
 * FIRST (it is the daemon-side default — the fork continues the parent's code state), then the
 * session repo's listed branches. Deduped; an unavailable/absent listing leaves just the parent
 * (or nothing — the picker then falls back to continuing in the parent's worktree).
 */
export function forkBaseOptions(
  parentBranch: string | undefined,
  listing: RepoBranchesStatePayload | undefined,
): string[] {
  const listed = listing?.available ? listing.branches : [];
  if (parentBranch === undefined) return [...listed];
  return [parentBranch, ...listed.filter((branch) => branch !== parentBranch)];
}
