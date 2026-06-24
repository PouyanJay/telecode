import { GitHub, generateState } from 'arctic';

import type { OAuthProvider, ProviderIdentity } from './provider';

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
      const url = github.createAuthorizationURL(state, ['read:user', 'user:email']);
      return { kind: 'redirect', url: url.toString(), state };
    },
    async completeLogin({ code }): Promise<ProviderIdentity> {
      const tokens = await github.validateAuthorizationCode(code);
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.accessToken()}`, 'User-Agent': 'telecode' },
      });
      if (!res.ok) {
        throw new Error(`GitHub user lookup failed: ${res.status}`);
      }
      const gh = (await res.json()) as GithubUser;
      return {
        provider: 'github',
        providerUserId: String(gh.id),
        displayName: gh.name ?? gh.login,
        ...(gh.email ? { email: gh.email } : {}),
        ...(gh.avatar_url ? { avatarUrl: gh.avatar_url } : {}),
      };
    },
  };
}
