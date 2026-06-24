export { createDaemon } from './daemon';
export type { Daemon, DaemonOptions } from './daemon';

export { pairDevice } from './pairing';
export type { PairDeviceOptions, DeviceCredentials } from './pairing';

export { loadCredentials, saveCredentials } from './credentials';
export type { StoredCredentials } from './credentials';

export { createFakeAgentAdapter } from './agent-adapter';
export type {
  AgentAdapter,
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  CanUseTool,
  PermissionDecision,
  PermissionRequest,
} from './agent-adapter';
export { createClaudeAgentAdapter } from './claude-agent-adapter';
export type { ClaudeAgentAdapterOptions } from './claude-agent-adapter';
