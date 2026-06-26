import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

import { createDevProvider } from './dev-provider';
import { createGithubProvider } from './github-provider';
import type { OAuthProvider } from './provider';
import { selectEnabledProviders } from './provider-selection';

/**
 * The enabled provider registry. Real GitHub OAuth activates when its credentials are configured. The
 * local dev provider is offered ONLY in development and ONLY when no real provider is configured — a
 * production build never falls back to it (see {@link selectEnabledProviders}). `APP_URL` is the public
 * origin used to build the OAuth redirect URI.
 */
function build(): Map<string, OAuthProvider> {
  const providers = new Map<string, OAuthProvider>();
  const appUrl = env.APP_URL ?? 'http://127.0.0.1:5173';
  const enabled = selectEnabledProviders({
    dev,
    ...(env.GITHUB_CLIENT_ID ? { githubClientId: env.GITHUB_CLIENT_ID } : {}),
    ...(env.GITHUB_CLIENT_SECRET ? { githubClientSecret: env.GITHUB_CLIENT_SECRET } : {}),
  });

  for (const id of enabled) {
    switch (id) {
      case 'github':
        // selectEnabledProviders only yields 'github' when both credentials are present.
        providers.set(
          'github',
          createGithubProvider(
            env.GITHUB_CLIENT_ID!,
            env.GITHUB_CLIENT_SECRET!,
            `${appUrl}/auth/github/callback`,
          ),
        );
        break;
      case 'dev':
        providers.set('dev', createDevProvider());
        break;
      default:
        id satisfies never;
    }
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
