/**
 * @telecode/protocol — the single shared wire contract used by the relay, daemon, and web.
 *
 * One zod-validated `Envelope` is the only wire format; it must never drift. Validate inbound
 * data with {@link parseEnvelope} / {@link safeParseEnvelope} at every boundary and infer types
 * from the schemas via `z.infer` rather than hand-writing parallel interfaces.
 */

export {
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  messageTypeSchema,
  envelopeSchema,
  echoPayloadSchema,
  peerRoleSchema,
  helloPayloadSchema,
  parseEnvelope,
  safeParseEnvelope,
  makeEnvelope,
} from './envelope';
export type { MessageType, Envelope, EchoPayload, PeerRole, HelloPayload } from './envelope';

export { ready, generateKeyPair, seal, open, encodeKey, decodeKey } from './crypto';
export type { KeyPair, SealedMessage } from './crypto';

export { deviceCodeRequestSchema, deviceCodeResponseSchema, pollResultSchema } from './device-auth';
export type { DeviceCodeRequest, DeviceCodeResponse, PollResult } from './device-auth';

export {
  permissionModeSchema,
  sessionLaunchPayloadSchema,
  sessionStartedPayloadSchema,
  SESSION_STATUSES,
  sessionStatusSchema,
  agentMessagePayloadSchema,
  agentToolUsePayloadSchema,
  sessionEndedPayloadSchema,
  sessionStatusPayloadSchema,
} from './session';
export type {
  PermissionModeName,
  SessionLaunchPayload,
  SessionStartedPayload,
  SessionStatusName,
  AgentMessagePayload,
  AgentToolUsePayload,
  SessionEndedPayload,
  SessionStatusPayload,
} from './session';
