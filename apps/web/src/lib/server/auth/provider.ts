/**
 * The injectable OAuth provider seam. A provider either redirects the browser to an external authorize
 * URL (GitHub) or resolves an identity immediately (the local dev provider). The web tier verifies the
 * identity, then hands it to the relay to mint a session — the relay owns persistence (AD-1/AD-3).
 */

export interface ProviderIdentity {
  readonly provider: string;
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export type LoginStart =
  | { readonly kind: 'redirect'; readonly url: string; readonly state: string }
  | { readonly kind: 'identity'; readonly identity: ProviderIdentity };

export interface OAuthProvider {
  readonly id: string;
  readonly label: string;
  /** Begin login: a redirect URL for external providers, or an immediate identity for dev. */
  beginLogin(redirectUri: string): LoginStart;
  /** Complete an external provider's callback into a verified identity. */
  completeLogin(params: { code: string; redirectUri: string }): Promise<ProviderIdentity>;
}
