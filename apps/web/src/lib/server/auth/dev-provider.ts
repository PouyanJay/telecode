import type { OAuthProvider } from './provider';

/**
 * Local/CI dev identity provider. It performs no real OAuth — it resolves a fixed identity immediately,
 * so local development and CI (which can never reach github.com) get a complete, deterministic sign-in
 * flow. Enabled only when no real provider is configured (see ./providers).
 */
export function createDevProvider(): OAuthProvider {
  return {
    id: 'dev',
    label: 'Continue as developer',
    beginLogin() {
      return {
        kind: 'identity',
        identity: {
          provider: 'dev',
          providerUserId: 'dev-user',
          displayName: 'Developer',
          email: 'dev@telecode.local',
        },
      };
    },
    completeLogin() {
      return Promise.reject(new Error('dev provider has no OAuth callback'));
    },
  };
}
