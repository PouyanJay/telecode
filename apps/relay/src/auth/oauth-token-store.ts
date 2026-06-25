import { decodeKey, openSecret, sealSecret } from '@telecode/protocol';
import { eq } from 'drizzle-orm';

import { type DbHandle } from '../db/client';
import { oauthTokens } from '../db/schema';

/** A user's decrypted OAuth access token, for the relay's own use (e.g. listing repos). */
export interface StoredOAuthToken {
  readonly accessToken: string;
  readonly scope: string | null;
}

/**
 * Persists the user's OAuth access token encrypted at rest (the `oauth_tokens` table). The token is a
 * secret only the relay's trusted owner path touches, so all access runs on the owner connection — NOT
 * `withUserContext` — and the table is RLS-locked deny-all to the user-scoped role. The plaintext is
 * never stored: it is sealed with a `secretbox` symmetric key before it reaches Postgres.
 */
export interface OAuthTokenStore {
  /** Upsert (one row per user) the user's access token, encrypting it before storage. */
  storeToken(input: { userId: string; accessToken: string; scope?: string }): Promise<void>;
  /** Read + decrypt the user's stored token, or null if none is stored. */
  getToken(userId: string): Promise<StoredOAuthToken | null>;
}

export interface OAuthTokenStoreOptions {
  readonly db: DbHandle;
  /** Base64 of a 32-byte symmetric key (the relay's `TOKEN_ENCRYPTION_KEY`) for at-rest encryption. */
  readonly encryptionKey: string;
}

export function createOAuthTokenStore(options: OAuthTokenStoreOptions): OAuthTokenStore {
  const { db } = options;
  const key = decodeKey(options.encryptionKey);
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  }

  return {
    async storeToken({ userId, accessToken, scope }): Promise<void> {
      const sealed = await sealSecret(accessToken, key);
      const now = new Date();
      const values = {
        accessTokenCipher: sealed.ciphertext,
        accessTokenNonce: sealed.nonce,
        scope: scope ?? null,
        updatedAt: now,
      };
      // Owner connection (oauth_tokens is owner-only — no withUserContext). Upsert keeps one row per user.
      await db.db
        .insert(oauthTokens)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: oauthTokens.userId, set: values });
    },

    async getToken(userId): Promise<StoredOAuthToken | null> {
      const [row] = await db.db
        .select({
          cipher: oauthTokens.accessTokenCipher,
          nonce: oauthTokens.accessTokenNonce,
          scope: oauthTokens.scope,
        })
        .from(oauthTokens)
        .where(eq(oauthTokens.userId, userId))
        .limit(1);
      if (!row) {
        return null;
      }
      const accessToken = await openSecret({ nonce: row.nonce, ciphertext: row.cipher }, key);
      return { accessToken, scope: row.scope };
    },
  };
}
