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

/** The lifecycle states a session moves through; mirrors the `session.status` wire values. */
export const SESSION_STATUSES = [
  'starting',
  'running',
  'awaiting_input',
  'done',
  'error',
  'offline_paused',
] as const;

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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
