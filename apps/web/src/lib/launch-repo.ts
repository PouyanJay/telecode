import type { SessionRepo } from '@telecode/protocol';

/** A repo the launch picker offers — the fields needed to label it and clone it on launch. */
export interface RepoOption {
  readonly id: number;
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly cloneUrl: string;
}

/**
 * Map the picker's selected repo id (the `<select>` value; `''` = no repo) to the `session.launch`
 * repo payload, or `undefined` to run in the daemon's default cwd. Returns `undefined` for an id that is
 * not in the list (stale selection) rather than guessing.
 */
export function launchRepo(repos: RepoOption[], selectedId: string): SessionRepo | undefined {
  if (!selectedId) return undefined;
  const repo = repos.find((option) => String(option.id) === selectedId);
  if (!repo) return undefined;
  return { owner: repo.owner, name: repo.name, cloneUrl: repo.cloneUrl };
}
