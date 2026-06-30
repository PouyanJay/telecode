import { SESSION_ORIGINS, SESSION_STATUSES } from '@telecode/protocol';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * The relay's persisted registries (the control plane owns DB access — see SUPABASE.md). Drizzle owns
 * the structural DDL here; RLS, roles, and policies are hand-authored into the generated migration
 * (Drizzle does not emit them). Every table is user-scoped and protected by Row Level Security keyed on
 * the per-transaction GUC `telecode.user_id` (see {@link withUserContext}); the wire/JSON contracts stay
 * in `@telecode/protocol`, these are the internal domain tables.
 *
 * Tightly-coupled sibling table definitions live together in this one schema module by design (the
 * "one public export per file" rule exempts sibling schemas).
 */

/** Identity rows, one per signed-in user. Created on the trusted OAuth path (server-derived). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** OAuth provider id, e.g. `github` or the local `dev` provider. */
    provider: text('provider').notNull(),
    /** The provider's stable id/login for this user. */
    providerUserId: text('provider_user_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerIdentity: unique('users_provider_identity_unique').on(t.provider, t.providerUserId),
  }),
);

/** Paired laptops (the device registry). One device = one daemon channel for `(user_id, device_id)`. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Human label (hostname) shown in Settings. */
    name: text('name').notNull(),
    /** X25519 public key (base64), registered at pairing. Stored now; used for E2E in Phase 3. */
    publicKey: text('public_key'),
    /** Short OS descriptor (e.g. "macOS 15.4"), reported by the daemon at pairing; null if unknown. */
    os: text('os'),
    /** Hash of the long-lived device token. The raw token is never persisted. */
    deviceTokenHash: text('device_token_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('devices_user_id_idx').on(t.userId),
  }),
);

/** Agent sessions (the plan's "session registry") — one row per launched Claude Code session. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    title: text('title'),
    status: text('status', { enum: SESSION_STATUSES }).default('starting').notNull(),
    /**
     * How the session came to exist: `launched` (started from telecode, daemon-driven via the SDK) or
     * `external` (a Claude Code session the user started themselves, adopted via the hooks bridge). Defaults
     * to `launched` so every pre-existing row and every browser-initiated launch is unchanged.
     */
    origin: text('origin', { enum: SESSION_ORIGINS }).default('launched').notNull(),
    /** Working directory the session runs in (single cwd in Phase 1; worktrees in Phase 2). */
    cwd: text('cwd'),
    permissionMode: text('permission_mode'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('sessions_user_id_idx').on(t.userId),
    deviceIdx: index('sessions_device_id_idx').on(t.deviceId),
  }),
);

/**
 * Browser login sessions (distinct from agent `sessions`). The cookie holds a high-entropy random
 * token; only its SHA-256 hash is stored here. Touched exclusively on the trusted relay auth path
 * (owner connection, RLS-bypassing) — there is no user-scoped `telecode_app` access, so RLS is enabled
 * with no policy (deny-all to the app role).
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hash (hex) of the session token; the raw token lives only in the browser cookie. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('auth_sessions_user_id_idx').on(t.userId),
  }),
);

/**
 * The user's OAuth access token (e.g. GitHub with `repo` scope), encrypted at rest. One row per user
 * (PK = user_id). The token is a secret only the relay's trusted owner path touches — to list repos on
 * the user's behalf — so, like {@link authSessions}, RLS is enabled with NO policy (deny-all to the
 * user-scoped `telecode_app` role); it is never exposed to the browser. The plaintext token is never
 * stored: `access_token_cipher`/`access_token_nonce` hold a `secretbox`-sealed value (see
 * `@telecode/protocol` `sealSecret`).
 */
export const oauthTokens = pgTable('oauth_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessTokenCipher: text('access_token_cipher').notNull(),
  accessTokenNonce: text('access_token_nonce').notNull(),
  /** Space-separated OAuth scopes granted with this token (e.g. `repo read:user`). */
  scope: text('scope'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Web-push subscriptions, one row per browser/endpoint the user enabled notifications on. Relay-managed
 * (the relay sends a push when a session goes `awaiting_input`), so — like {@link authSessions} and
 * {@link oauthTokens} — RLS is enabled with NO policy (deny-all to the user-scoped `telecode_app` role);
 * the browser registers/removes a subscription via a bearer-authed BFF endpoint, never by querying here.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The push service endpoint URL (unique per browser subscription). */
    endpoint: text('endpoint').notNull().unique(),
    /** The subscription's public key + auth secret (base64url), used by web-push to encrypt the payload. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('push_subscriptions_user_id_idx').on(t.userId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
