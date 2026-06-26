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

export {
  ready,
  generateKeyPair,
  seal,
  open,
  encodeKey,
  decodeKey,
  generateSecretKey,
  sealSecret,
  openSecret,
} from './crypto';
export type { KeyPair, SealedMessage } from './crypto';

export { ProtocolError } from './errors';

export {
  sealEnvelopePayload,
  openEnvelopePayload,
  requireCiphertext,
  parsePlaintext,
} from './envelope-crypto';
export type { EncryptedEnvelopeFields } from './envelope-crypto';

export {
  generateContentKey,
  wrapContentKey,
  unwrapContentKey,
  encryptWithContentKey,
  decryptWithContentKey,
} from './session-crypto';

export { deviceCodeRequestSchema, deviceCodeResponseSchema, pollResultSchema } from './device-auth';
export type { DeviceCodeRequest, DeviceCodeResponse, PollResult } from './device-auth';

export {
  base64KeySchema,
  permissionModeSchema,
  sessionRepoSchema,
  sessionLaunchPayloadSchema,
  sessionStartedPayloadSchema,
  SESSION_STATUSES,
  sessionStatusSchema,
  devicePresencePayloadSchema,
  agentMessagePayloadSchema,
  agentToolUsePayloadSchema,
  sessionEndedPayloadSchema,
  sessionKeyPayloadSchema,
  agentPermissionRequestPayloadSchema,
  permissionDecisionPayloadSchema,
  userMessagePayloadSchema,
  sessionControlActionSchema,
  sessionControlPayloadSchema,
  sessionSubscribePayloadSchema,
  sessionHistoryEntrySchema,
  sessionHistoryPayloadSchema,
} from './session';
export type {
  PermissionModeName,
  SessionRepo,
  SessionLaunchPayload,
  SessionStartedPayload,
  SessionStatusName,
  DevicePresencePayload,
  AgentMessagePayload,
  AgentToolUsePayload,
  SessionEndedPayload,
  SessionKeyPayload,
  AgentPermissionRequestPayload,
  PermissionDecisionPayload,
  UserMessagePayload,
  SessionControlAction,
  SessionControlPayload,
  SessionSubscribePayload,
  SessionHistoryEntry,
  SessionHistoryPayload,
} from './session';
