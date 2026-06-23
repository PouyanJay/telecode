import { z } from 'zod';

/**
 * Wire contracts for the Device Authorization Grant, shared by the relay (server) and the daemon
 * (client) so the shapes can never drift. Both sides validate with these — no hand-written parallel
 * interfaces, no `as` casts across the HTTP boundary.
 */

export const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

export const pollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    device_token: z.string().min(1),
    user_id: z.string().min(1),
  }),
]);
export type PollResult = z.infer<typeof pollResultSchema>;
