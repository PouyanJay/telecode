import { GitHub, generateState } from 'arctic';

import type { CompletedLogin, OAuthProvider } from './provider';

/**
 * OAuth scopes requested from GitHub. `repo` lets the user pick any repo (public or private) to launch
 * a session against (Phase 2); `read:user`/`user:email` resolve the identity. GitHub may grant a subset.
 */
const GITHUB_SCOPES = ['repo', 'read:user', 'user:email'];

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/**
 * Real GitHub OAuth via Arctic. Active only when GITHUB_CLIENT_ID/SECRET are configured (see
 * ./providers); otherwise the dev provider is used. The redirect URI is fixed per OAuth app and baked
 * into the client at construction.
 */
export function createGithubProvider(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): OAuthProvider {
  const github = new GitHub(clientId, clientSecret, redirectUri);

  return {
    id: 'github',
    label: 'Continue with GitHub',
    beginLogin() {
      const state = generateState();
      const url = github.createAuthorizationURL(state, GITHUB_SCOPES);
      return { kind: 'redirect', url: url.toString(), state };
    },
    async completeLogin({ code }): Promise<CompletedLogin> {
      const tokens = await github.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'telecode' },
      });
      if (!res.ok) {
        throw new Error(`GitHub user lookup failed: ${res.status}`);
      }
      const gh = (await res.json()) as GithubUser;
      return {
        identity: {
          provider: 'github',
          providerUserId: String(gh.id),
          displayName: gh.name ?? gh.login,
          ...(gh.email ? { email: gh.email } : {}),
          ...(gh.avatar_url ? { avatarUrl: gh.avatar_url } : {}),
        },
        accessToken,
        // The requested scopes; GitHub may grant a subset (recorded for diagnostics, not enforcement).
        scope: GITHUB_SCOPES.join(' '),
      };
    },
  };
}
