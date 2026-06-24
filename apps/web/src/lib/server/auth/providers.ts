import { env } from '$env/dynamic/private';

import { createDevProvider } from './dev-provider';
import { createGithubProvider } from './github-provider';
import type { OAuthProvider } from './provider';

/**
 * The enabled provider registry. Real GitHub OAuth activates when its credentials are configured;
 * otherwise the local dev provider is the sign-in path (Phase 1 ships dev login, with real GitHub a
 * pure config swap). `APP_URL` is the public origin used to build the OAuth redirect URI.
 */
function build(): Map<string, OAuthProvider> {
  const providers = new Map<string, OAuthProvider>();
  const appUrl = env.APP_URL ?? 'http://127.0.0.1:5173';

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.set(
      'github',
      createGithubProvider(
        env.GITHUB_CLIENT_ID,
        env.GITHUB_CLIENT_SECRET,
        `${appUrl}/auth/github/callback`,
      ),
    );
  } else {
    // No real provider configured → offer dev login so the flow is complete locally and in CI.
    providers.set('dev', createDevProvider());
  }
  return providers;
}

const registry = build();

export function getProvider(id: string): OAuthProvider | undefined {
  return registry.get(id);
}

export function listProviders(): ReadonlyArray<{ id: string; label: string }> {
  return [...registry.values()].map((p) => ({ id: p.id, label: p.label }));
}
