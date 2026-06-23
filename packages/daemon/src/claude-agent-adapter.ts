import {
  query,
  type PermissionMode,
  type PermissionResult,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { pino, type Logger } from 'pino';

import type { AgentAdapter, AgentRunResult, CanUseTool, PermissionRequest } from './agent-adapter';

/**
 * The real {@link AgentAdapter} backed by the Claude Agent SDK. Maps the SDK's `canUseTool` callback
 * onto our {@link CanUseTool} contract and drives the session to completion. Requires
 * `ANTHROPIC_API_KEY` (or Claude Code auth) in the environment.
 */
export interface ClaudeAgentAdapterOptions {
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: string[];
  readonly maxTurns?: number;
  readonly model?: string;
  /**
   * Which on-disk settings to load. Defaults to `[]` (none) so the daemon runs an isolated session
   * and never inherits the operator's personal Claude config — and so every tool actually routes
   * through `canUseTool` instead of being auto-allowed by ambient rules.
   */
  readonly settingSources?: SettingSource[];
  readonly logger?: Logger;
}

export function createClaudeAgentAdapter(options: ClaudeAgentAdapterOptions = {}): AgentAdapter {
  const log = options.logger ?? pino({ name: 'claude-agent-adapter' });

  return {
    async run(prompt: string, canUseTool: CanUseTool): Promise<AgentRunResult> {
      const intercepted: PermissionRequest[] = [];
      const allowed: string[] = [];
      const denied: string[] = [];

      const sdkCanUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
      ): Promise<PermissionResult> => {
        const request: PermissionRequest = { toolName, input };
        intercepted.push(request);
        const decision = await canUseTool(request);
        if (decision.behavior === 'allow') {
          allowed.push(toolName);
          return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
        }
        denied.push(toolName);
        return { behavior: 'deny', message: decision.message };
      };

      const session = query({
        prompt,
        options: {
          canUseTool: sdkCanUseTool,
          permissionMode: options.permissionMode ?? 'default',
          maxTurns: options.maxTurns ?? 4,
          settingSources: options.settingSources ?? [],
          ...(options.model ? { model: options.model } : {}),
          ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
        },
      });

      for await (const message of session) {
        // Drive the session to completion; canUseTool above records every interception.
        log.debug({ type: message.type }, 'agent message');
      }

      log.debug({ intercepted: intercepted.length }, 'agent session complete');
      return { intercepted, allowed, denied };
    },
  };
}
