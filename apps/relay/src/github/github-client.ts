import { z } from 'zod';

/**
 * The seam that isolates GitHub's REST API from the relay's routes — a DI boundary like the daemon's
 * `AgentAdapter`, so the real network impl is swapped for a fake in tests. The relay calls GitHub on the
 * user's behalf using their stored token (never exposed to the browser); only the minimal repo fields
 * the launch picker needs are surfaced.
 */
export interface GithubRepo {
  readonly id: number;
  readonly fullName: string;
  readonly name: string;
  readonly owner: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  /** HTTPS clone URL — the daemon clones this (with the laptop's own git credentials) on launch. */
  readonly cloneUrl: string;
}

export interface GithubClient {
  /** List repos the access token can see. Throws on a GitHub error (e.g. a revoked token). */
  listRepos(accessToken: string): Promise<GithubRepo[]>;
  /** List a repo's branch names (first page, launch-picker scale). Throws on a GitHub error. */
  listBranches(accessToken: string, owner: string, name: string): Promise<string[]>;
}

/** The one field we read from GitHub's branch listing — validated at this trust boundary. */
const githubApiBranchesSchema = z.array(z.object({ name: z.string() }));

/** The fields we read from GitHub's `GET /user/repos` response — validated at this trust boundary. */
const githubApiReposSchema = z.array(
  z.object({
    id: z.number(),
    full_name: z.string(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
    private: z.boolean(),
    default_branch: z.string(),
    clone_url: z.string(),
  }),
);

/** Error thrown when GitHub rejects the request, with the HTTP status for the route to map to 502. */
export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

/**
 * The first page (up to 100, most recently pushed) of repos the user can access — enough for the launch
 * picker in Phase 2. NOTE: this does not paginate, so a user with >100 repos sees only the newest 100;
 * full pagination is a later refinement (called out rather than silently truncating).
 */
const REPOS_URL =
  'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';

export function createGithubClient(): GithubClient {
  return {
    async listRepos(accessToken: string): Promise<GithubRepo[]> {
      const res = await fetch(REPOS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'telecode',
        },
      });
      if (!res.ok) {
        throw new GithubApiError(`GitHub repo listing failed: ${res.status}`, res.status);
      }
      const parsed = githubApiReposSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new GithubApiError('unexpected GitHub repo-listing response shape', 502);
      }
      return parsed.data.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        private: repo.private,
        defaultBranch: repo.default_branch,
        cloneUrl: repo.clone_url,
      }));
    },

    async listBranches(accessToken: string, owner: string, name: string): Promise<string[]> {
      // Owner/name are boundary-validated by the route; encode anyway so they can never re-shape the URL.
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'telecode',
        },
      });
      if (!res.ok) {
        throw new GithubApiError(`GitHub branch listing failed: ${res.status}`, res.status);
      }
      const parsed = githubApiBranchesSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new GithubApiError('unexpected GitHub branch-listing response shape', 502);
      }
      return parsed.data.map((branch) => branch.name);
    },
  };
}
