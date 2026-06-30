import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createFakeInfraScaler, type InfraScaler } from '../../src/infra/infra-scaler';
import { buildRelay } from '../../src/relay';

/**
 * Operator-only infra controls — the scale-to-zero toggles. These flip a SHARED-deployment setting for all
 * users, so every request is gated to the operator allowlist; a non-operator (any ordinary signed-in user)
 * is forbidden. Real relay + Postgres + a fake {@link InfraScaler} (no cloud call). Reads/writes go through
 * `/me/infra-settings`, session-token authed.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';
const OPERATOR_EMAIL = 'operator@telecode.io';

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('operator infra-settings: GET/PUT /me/infra-settings', () => {
  let app: FastifyInstance;
  let auth: AuthService;
  let handle: DbHandle;
  let admin: Pool;
  let scaler: InfraScaler & { readonly settings: { webAlwaysOn: boolean; relayAlwaysOn: boolean } };

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
  });

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
    // Fresh scaler + relay per test so toggles don't leak across cases (both apps start always-on).
    scaler = createFakeInfraScaler();
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      infra: { scaler, operatorEmails: [OPERATOR_EMAIL] },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  async function operatorToken(): Promise<string> {
    return (
      await auth.createSession({ provider: 'dev', providerUserId: 'op', email: OPERATOR_EMAIL })
    ).token;
  }
  async function userToken(): Promise<string> {
    return (
      await auth.createSession({
        provider: 'dev',
        providerUserId: 'rando',
        email: 'rando@example.com',
      })
    ).token;
  }

  it('lets an operator read the current always-on state of both apps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/infra-settings',
      headers: bearer(await operatorToken()),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ web_always_on: true, relay_always_on: true });
  });

  it('lets an operator scale an app to zero, and reflects it back', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/me/infra-settings',
      headers: bearer(await operatorToken()),
      payload: { target: 'relay', always_on: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ web_always_on: true, relay_always_on: false });
    // The scaler actually applied it (web untouched).
    expect(scaler.settings).toEqual({ webAlwaysOn: true, relayAlwaysOn: false });
  });

  it('forbids a non-operator from reading OR changing scale (and nothing is applied)', async () => {
    const token = await userToken();
    const read = await app.inject({
      method: 'GET',
      url: '/me/infra-settings',
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: 'PUT',
      url: '/me/infra-settings',
      headers: bearer(token),
      payload: { target: 'web', always_on: false },
    });
    expect(write.statusCode).toBe(403);
    expect(scaler.settings).toEqual({ webAlwaysOn: true, relayAlwaysOn: true });
  });

  it('rejects an unauthenticated request with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/infra-settings' })).statusCode).toBe(401);
  });

  it('rejects a malformed update body with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/me/infra-settings',
      headers: bearer(await operatorToken()),
      payload: { target: 'nope', always_on: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('infra-settings is absent when not configured', () => {
  let app: FastifyInstance;
  let auth: AuthService;
  let handle: DbHandle;
  let admin: Pool;

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
    // Single test in this block, so the one-time truncate + build in beforeAll is sufficient; add a
    // beforeEach truncate here if a second scenario is added (tests must stay order-independent).
    await admin.query('truncate table users restart identity cascade');
    // No `infra` option → the routes are never registered (the web hides the panel).
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  it('404s the endpoint so an operator-less / non-Azure relay simply has no controls', async () => {
    const token = (
      await auth.createSession({ provider: 'dev', providerUserId: 'op', email: OPERATOR_EMAIL })
    ).token;
    const res = await app.inject({
      method: 'GET',
      url: '/me/infra-settings',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(404);
  });
});
