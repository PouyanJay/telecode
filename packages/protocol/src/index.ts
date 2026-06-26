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
  encodeKey,
  decodeKey,
  generateSecretKey,
  sealSecret,
  openSecret,
} from './crypto';
export type { KeyPair, SealedMessage } from './crypto';

export { ProtocolError } from './errors';

export { requireCiphertext, parsePlaintext } from './envelope-crypto';
export type { EncryptedEnvelopeFields } from './envelope-crypto';

// Phase 4 E2E session crypto: WebCrypto ECDH(X25519) → HKDF-SHA256 → AES-256-GCM. Replaces the former
// tweetnacl box/secretbox session path so the browser can hold a non-extractable identity key.
export {
  generateIdentityKeyPair,
  exportIdentityPublicKey,
  importIdentityPublicKey,
  importIdentityPrivateKey,
  deriveSharedKey,
  generateContentKey,
  importContentKey,
  exportContentKey,
  sealPayload,
  openPayload,
} from './webcrypto';
export type { CryptoKeyHandle, CryptoKeyPairHandle } from './webcrypto';

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
