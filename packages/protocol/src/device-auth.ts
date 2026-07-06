import { z } from 'zod';

/**
 * Wire contracts for the Device Authorization Grant, shared by the relay (server) and the daemon
 * (client) so the shapes can never drift. Both sides validate with these — no hand-written parallel
 * interfaces, no `as` casts across the HTTP boundary.
 */

/**
 * Body the daemon sends to `POST /device/code` — a human label, its X25519 public key (base64), and a
 * short OS descriptor (e.g. "macOS 15.4", "Ubuntu 24.04") shown next to the device in the UI.
 *
 * `prior_device_token` is restore evidence: a daemon whose device was revoked presents its old token
 * so the relay can re-authorize the SAME device row (identity + session history preserved) instead of
 * minting a new one. Possession of the old token is the continuity proof; the relay only honors it
 * when the original owner approves the new code. Optional and additive — old daemons never send it,
 * old relays strip it.
 */
export const deviceCodeRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  public_key: z.string().min(1).optional(),
  os: z.string().min(1).max(64).optional(),
  prior_device_token: z.string().min(1).max(128).optional(),
});
export type DeviceCodeRequest = z.infer<typeof deviceCodeRequestSchema>;

export const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

/**
 * Body `POST /device/approve` returns to the web tier. `restored` is true when the approval
 * re-authorized an existing revoked device (same identity, history preserved) rather than pairing a
 * new one; `device_name` names the restored device so the UI can say so (null on a fresh pair — the
 * row didn't exist before this approval).
 */
export const deviceApproveResponseSchema = z.object({
  ok: z.literal(true),
  restored: z.boolean(),
  device_name: z.string().nullable(),
});
export type DeviceApproveResponse = z.infer<typeof deviceApproveResponseSchema>;

export const pollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    device_token: z.string().min(1),
    user_id: z.string().min(1),
    device_id: z.string().min(1),
  }),
]);
export type PollResult = z.infer<typeof pollResultSchema>;
