/**
 * Pure provider-selection logic, kept free of SvelteKit module aliases so it is unit-testable.
 *
 * Security invariant: the dev provider signs anyone in with no real authentication, so it is offered
 * **only in development** and **only when no real provider is configured**. A production build never falls
 * back to dev login — if no real provider is configured it offers nothing (fail closed), so a public
 * deployment can never accidentally expose an unauthenticated "developer" account.
 */
export interface ProviderEnvironment {
  /** True under `vite dev` (local + CI e2e); false in any production build. */
  readonly dev: boolean;
  readonly githubClientId?: string;
  readonly githubClientSecret?: string;
}

export type EnabledProvider = 'github' | 'dev';

export function selectEnabledProviders(environment: ProviderEnvironment): EnabledProvider[] {
  const enabled: EnabledProvider[] = [];
  if (environment.githubClientId && environment.githubClientSecret) {
    enabled.push('github');
  }
  if (environment.dev && enabled.length === 0) {
    enabled.push('dev');
  }
  return enabled;
}
