export { createDaemon } from './daemon';
export type { Daemon, DaemonOptions } from './daemon';

export { pairDevice } from './pairing';
export type { PairDeviceOptions, DeviceCredentials } from './pairing';

export { createFakeAgentAdapter } from './agent-adapter';
export type {
  AgentAdapter,
  AgentRunResult,
  CanUseTool,
  PermissionDecision,
  PermissionRequest,
} from './agent-adapter';
export { createClaudeAgentAdapter } from './claude-agent-adapter';
export type { ClaudeAgentAdapterOptions } from './claude-agent-adapter';
