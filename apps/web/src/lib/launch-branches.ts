import type { RepoBranchesStatePayload } from '@telecode/protocol';

import type { RelayRepo } from '$lib/server/relay-api';

/**
 * The launch drawer's base-branch picker model (branch-launch Phase B), derived purely so the drawer
 * stays declarative and this is unit-testable. Two sources, one shape: a selected GitHub repo lists
 * via the relay (fetched by the drawer, passed in as `github`); "no repo" lists the launch device's
 * DEFAULT repo via the sealed daemon round-trip (`local`). `hidden` means offer no picker at all —
 * the launch then omits `baseBranch` and the daemon keeps its pre-Phase-B HEAD default.
 */
export type BranchPickerModel =
  | { readonly status: 'hidden' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly branches: readonly string[];
      readonly defaultBranch: string | null;
    };

export interface GithubBranchFetch {
  readonly state: 'idle' | 'loading' | 'loaded' | 'error';
  readonly branches: readonly string[];
}

export function buildBranchPickerModel(input: {
  /** The selected GitHub repo, or null for "no repo — default workspace". */
  readonly repo: RelayRepo | null;
  /** The drawer's fetch state for the selected GitHub repo's branches. */
  readonly github: GithubBranchFetch;
  /** The launch device's sealed `repo.branches.state` reply, if it has arrived. */
  readonly local: RepoBranchesStatePayload | undefined;
}): BranchPickerModel {
  if (input.repo !== null) {
    if (input.github.state === 'loading' || input.github.state === 'idle') {
      return { status: 'loading' };
    }
    if (input.github.state === 'error') return { status: 'error' };
    if (input.github.branches.length === 0) return { status: 'hidden' };
    return {
      status: 'ready',
      branches: input.github.branches,
      // The repo row knows its default — but the picker may only hold the first API page, so a
      // default beyond it must not pre-select an option that isn't rendered.
      defaultBranch: input.github.branches.includes(input.repo.defaultBranch)
        ? input.repo.defaultBranch
        : null,
    };
  }
  // No repo selected: the device's default workspace. No reply yet → quiet (the request is in
  // flight or the daemon predates the RPC); unavailable/empty → hidden — never a dead-end spinner.
  if (input.local === undefined) return { status: 'hidden' };
  if (!input.local.available || input.local.branches.length === 0) return { status: 'hidden' };
  const localDefault = input.local.defaultBranch;
  return {
    status: 'ready',
    branches: input.local.branches,
    defaultBranch:
      localDefault !== undefined && input.local.branches.includes(localDefault)
        ? localDefault
        : null,
  };
}
