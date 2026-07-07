/**
 * `owner/name` when a remote URL points at github.com (ssh, https, or ssh:// forms), else
 * `undefined` — the browser only gets a PR link it can actually open. Independent of the push
 * seam (its own file per the one-public-export rule); anchored against lookalike hosts.
 */
export function parseGithubRemote(url: string): string | undefined {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}
