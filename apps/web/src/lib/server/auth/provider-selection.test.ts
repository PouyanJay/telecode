import { describe, expect, it } from 'vitest';

import { selectEnabledProviders } from './provider-selection';

describe('sign-in provider selection', () => {
  it('uses GitHub when credentials are configured in production', () => {
    expect(
      selectEnabledProviders({ dev: false, githubClientId: 'id', githubClientSecret: 'secret' }),
    ).toEqual(['github']);
  });

  it('uses GitHub when credentials are configured in development', () => {
    expect(
      selectEnabledProviders({ dev: true, githubClientId: 'id', githubClientSecret: 'secret' }),
    ).toEqual(['github']);
  });

  it('falls back to dev login only in development when no real provider is configured', () => {
    expect(selectEnabledProviders({ dev: true })).toEqual(['dev']);
  });

  it('never offers dev login in production — fails closed when no provider is configured', () => {
    expect(selectEnabledProviders({ dev: false })).toEqual([]);
  });

  it('does not add dev login when GitHub is configured, even in development', () => {
    expect(
      selectEnabledProviders({ dev: true, githubClientId: 'id', githubClientSecret: 'secret' }),
    ).not.toContain('dev');
  });

  it('treats partial GitHub credentials (id only) as unconfigured', () => {
    expect(selectEnabledProviders({ dev: true, githubClientId: 'id' })).toEqual(['dev']);
    expect(selectEnabledProviders({ dev: false, githubClientId: 'id' })).toEqual([]);
  });

  it('treats partial GitHub credentials (secret only) as unconfigured', () => {
    expect(selectEnabledProviders({ dev: true, githubClientSecret: 'secret' })).toEqual(['dev']);
    expect(selectEnabledProviders({ dev: false, githubClientSecret: 'secret' })).toEqual([]);
  });

  it('treats empty-string credentials as absent — fails closed in production', () => {
    // An env var set to '' is common in CI; it must not count as a configured provider.
    expect(
      selectEnabledProviders({ dev: false, githubClientId: '', githubClientSecret: '' }),
    ).toEqual([]);
  });
});
