import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { type AuthService } from '../auth/auth-service';
import { requireOperator } from '../auth/require-operator';
import { type InfraScaler, type InfraSettings } from './infra-scaler';

/**
 * Web → relay operator endpoints for the scale-to-zero toggles. Registered ONLY when an {@link InfraScaler}
 * is configured (Azure env present), so a relay without it simply 404s these paths and the UI hides the
 * panel. Every request is gated to the operator allowlist (these controls affect the shared deployment for
 * all users), so a non-operator gets 403. Session-token authed.
 *   - `GET /me/infra-settings` — current always-on state of both apps (read live from the cloud).
 *   - `PUT /me/infra-settings` — pin one app always-on or let it scale to zero.
 */
const updateBodySchema = z.object({
  target: z.enum(['web', 'relay']),
  always_on: z.boolean(),
});

function toWire(settings: InfraSettings): { web_always_on: boolean; relay_always_on: boolean } {
  return { web_always_on: settings.webAlwaysOn, relay_always_on: settings.relayAlwaysOn };
}

export function registerInfraRoutes(
  app: FastifyInstance,
  auth: AuthService,
  scaler: InfraScaler,
  operatorEmails: readonly string[],
): void {
  app.get('/me/infra-settings', async (request, reply) => {
    if (!(await requireOperator(request, reply, auth, operatorEmails))) return reply;
    try {
      return reply.send(toWire(await scaler.getSettings()));
    } catch (err) {
      request.log.error({ err }, 'infra-settings: failed to read scale');
      return reply.code(502).send({ error: 'cloud_unavailable' });
    }
  });

  app.put('/me/infra-settings', async (request, reply) => {
    if (!(await requireOperator(request, reply, auth, operatorEmails))) return reply;
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      await scaler.setAlwaysOn(body.data.target, body.data.always_on);
      request.log.info(
        { target: body.data.target, alwaysOn: body.data.always_on },
        'infra-settings: scale updated',
      );
      // Return the freshly-read state so the UI reflects what the cloud actually applied.
      return reply.send(toWire(await scaler.getSettings()));
    } catch (err) {
      request.log.error(
        { err, target: body.data.target },
        'infra-settings: failed to update scale',
      );
      return reply.code(502).send({ error: 'cloud_unavailable' });
    }
  });
}
