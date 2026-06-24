import { createHash, randomBytes } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

import { type DbHandle } from '../db/client';
import { authSessions, users } from '../db/schema';

/**
 * A verified OAuth identity handed to the relay by the (trusted) web tier. This is a boundary contract,
 * so it is a zod schema; the relay parses the `/auth/session` body with it.
 */
export const providerIdentitySchema = z.object({
  /** OAuth provider id, e.g. `github` or the local `dev` provider. */
  provider: z.string().min(1),
  providerUserId: z.string().min(1),
  email: z.string().email().optional(),
  displayName: z.string().min(1).optional(),
  avatarUrl: z.string().url().optional(),
});
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;

/**
 * The relay's auth domain (the relay owns auth + the registries — AD-1/AD-3). It runs the OAuth-session
 * lifecycle and mints/verifies the short-lived **channel token** the browser presents on the WS.
 *
 * Trust model:
 *  - `createSession` / `validateSession` / `destroySession` run on the trusted owner connection (which has
 *    BYPASSRLS) — there is no authenticated user context yet, and `auth_sessions` is owner-only.
 *  - The cookie carries a high-entropy random token; only its SHA-256 hash is stored, so a DB read never
 *    yields a usable session token.
 *  - The channel token is a 60s HS256 JWT (`sub = user_id`, `aud = relay`); the long-lived session token
 *    never travels over the browser↔relay WS.
 */
export interface SessionToken {
  /** The raw token to set as the browser cookie. Only its hash is persisted. */
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

export interface AuthService {
  /** Upsert the user for a verified provider identity and open a login session. */
  createSession(identity: ProviderIdentity): Promise<SessionToken>;
  /** Resolve the user id for a raw session token, or null if unknown/expired. */
  validateSession(token: string): Promise<string | null>;
  /** Revoke a login session (logout). Idempotent. */
  destroySession(token: string): Promise<void>;
  /** Mint a short-lived channel token for a validated user to present on the relay WS. */
  mintChannelToken(userId: string): Promise<string>;
  /** Verify a channel token; resolve its `user_id` (sub) or null if invalid/expired. */
  verifyChannelToken(token: string): Promise<string | null>;
}

export interface AuthServiceOptions {
  readonly db: DbHandle;
  /** HS256 secret for channel tokens. */
  readonly channelTokenSecret: string;
  readonly sessionTtlMs?: number;
  readonly channelTokenTtlSec?: number;
  readonly now?: () => number;
}

const CHANNEL_AUDIENCE = 'telecode-relay';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db } = options;
  const now = options.now ?? ((): number => Date.now());
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60_000; // 30 days
  const channelTokenTtlSec = options.channelTokenTtlSec ?? 60;
  const secretKey = new TextEncoder().encode(options.channelTokenSecret);

  return {
    async createSession(identity): Promise<SessionToken> {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now() + sessionTtlMs);
      const userId = await db.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            provider: identity.provider,
            providerUserId: identity.providerUserId,
            email: identity.email ?? null,
            displayName: identity.displayName ?? null,
            avatarUrl: identity.avatarUrl ?? null,
            updatedAt: new Date(now()),
          })
          .onConflictDoUpdate({
            target: [users.provider, users.providerUserId],
            set: {
              email: identity.email ?? null,
              displayName: identity.displayName ?? null,
              avatarUrl: identity.avatarUrl ?? null,
              updatedAt: new Date(now()),
            },
          })
          .returning({ id: users.id });
        if (!user) {
          throw new Error('user upsert returned no row');
        }
        await tx
          .insert(authSessions)
          .values({ userId: user.id, tokenHash: hashToken(token), expiresAt });
        return user.id;
      });
      return { token, userId, expiresAt };
    },

    async validateSession(token): Promise<string | null> {
      const [row] = await db.db
        .select({ userId: authSessions.userId })
        .from(authSessions)
        .where(
          and(
            eq(authSessions.tokenHash, hashToken(token)),
            gt(authSessions.expiresAt, new Date(now())),
          ),
        )
        .limit(1);
      return row?.userId ?? null;
    },

    async destroySession(token): Promise<void> {
      await db.db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
    },

    async mintChannelToken(userId): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setAudience(CHANNEL_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${channelTokenTtlSec}s`)
        .sign(secretKey);
    },

    async verifyChannelToken(token): Promise<string | null> {
      try {
        const { payload } = await jwtVerify(token, secretKey, { audience: CHANNEL_AUDIENCE });
        return typeof payload.sub === 'string' ? payload.sub : null;
      } catch {
        return null;
      }
    },
  };
}
