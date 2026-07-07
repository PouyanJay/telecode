/**
 * The PR page for a pushed session branch (branch-actions T6), opened in the USER'S OWN signed-in
 * browser — the whole point of the design: no GitHub token on the daemon or the relay path. With a
 * known base it is the compare/quick-pull page; without one (a detached-HEAD cut has no base name)
 * the plain new-PR page, which picks the repo's default base. Ref names keep their `/` (GitHub
 * expects it); everything else is URI-encoded.
 */
export function pullRequestUrl(githubRepo: string, branch: string, base?: string): string {
  const ref = (name: string): string => encodeURIComponent(name).replaceAll('%2F', '/');
  const [owner = '', name = ''] = githubRepo.split('/');
  const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return base !== undefined
    ? `https://github.com/${repo}/compare/${ref(base)}...${ref(branch)}?quick_pull=1`
    : `https://github.com/${repo}/pull/new/${ref(branch)}`;
}
