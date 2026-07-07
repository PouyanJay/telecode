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

export { WS_CLOSE_UNAUTHORIZED } from './ws-close-codes';

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

export {
  deviceApproveResponseSchema,
  deviceCodeRequestSchema,
  deviceCodeResponseSchema,
  pollResultSchema,
} from './device-auth';
export type {
  DeviceApproveResponse,
  DeviceCodeRequest,
  DeviceCodeResponse,
  PollResult,
} from './device-auth';

export {
  base64KeySchema,
  permissionModeSchema,
  repoPathSegmentSchema,
  sessionRepoSchema,
  MAX_REPO_BRANCHES,
  MAX_BRANCH_NAME_CHARS,
  sessionLaunchPayloadSchema,
  diffStatSchema,
  sessionResumeNewPayloadSchema,
  sessionStartedPayloadSchema,
  SESSION_ORIGINS,
  sessionOriginSchema,
  sessionAdoptedPayloadSchema,
  adoptSettingsSchema,
  adoptConfigPayloadSchema,
  adoptStatePayloadSchema,
  repoBranchesRequestPayloadSchema,
  repoBranchesStatePayloadSchema,
  SESSION_STATUSES,
  sessionStatusSchema,
  devicePresencePayloadSchema,
  relayErrorPayloadSchema,
  viewerPresencePayloadSchema,
  sessionReconcilePayloadSchema,
  entryTimestampSchema,
  TITLE_SOURCES,
  titleSourceSchema,
  sessionMetaPayloadSchema,
  sessionTitlePayloadSchema,
  MAX_SEALED_BLOB_CHARS,
  MAX_SEALED_BLOB_NONCE_CHARS,
  sessionRenameBodySchema,
  agentMessagePayloadSchema,
  agentNoticePayloadSchema,
  agentToolUsePayloadSchema,
  SESSION_END_STATUSES,
  isSessionEndStatus,
  isValidGitBranchName,
  sessionEndedPayloadSchema,
  sessionKeyPayloadSchema,
  agentPermissionRequestPayloadSchema,
  permissionDecisionPayloadSchema,
  agentQuestionOptionSchema,
  agentQuestionItemSchema,
  agentQuestionPayloadSchema,
  questionAnswerItemSchema,
  questionAnswerPayloadSchema,
  agentHandoverPayloadSchema,
  handoverAnswerPayloadSchema,
  sessionChainedPayloadSchema,
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
  DiffStat,
  SessionResumeNewPayload,
  SessionStartedPayload,
  SessionOrigin,
  SessionAdoptedPayload,
  AdoptSettings,
  AdoptConfigPayload,
  AdoptStatePayload,
  RepoBranchesRequestPayload,
  RepoBranchesStatePayload,
  SessionStatusName,
  DevicePresencePayload,
  RelayErrorPayload,
  ViewerPresencePayload,
  SessionReconcilePayload,
  EntryTimestamp,
  TitleSourceName,
  SessionMetaPayload,
  SessionTitlePayload,
  SessionRenameBody,
  AgentMessagePayload,
  AgentNoticePayload,
  AgentToolUsePayload,
  SessionEndedPayload,
  SessionKeyPayload,
  AgentPermissionRequestPayload,
  PermissionDecisionPayload,
  AgentQuestionOption,
  AgentQuestionItem,
  AgentQuestionPayload,
  QuestionAnswerItem,
  QuestionAnswerPayload,
  AgentHandoverPayload,
  HandoverAnswerPayload,
  SessionChainedPayload,
  UserMessagePayload,
  SessionControlAction,
  SessionControlPayload,
  SessionSubscribePayload,
  SessionHistoryEntry,
  SessionHistoryPayload,
} from './session';

export { firstRealPromptText, isInjectedPrompt } from './prompt';
