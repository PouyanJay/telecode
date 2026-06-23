/**
 * The seam that isolates the agent runtime from the rest of the daemon. Architecture invariant:
 * the Claude Agent SDK is used behind this one interface (never CLI scraping), so SDK churn touches
 * a single file and a future adapter for another coding agent slots in cleanly.
 *
 * The load-bearing piece is `canUseTool`: every tool the agent wants to run is routed through it for
 * an allow/deny decision. In the product the daemon forwards that request to the browser (the
 * human-in-the-loop gate) and returns the human's decision; here the contract is defined and proven.
 */

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type CanUseTool = (request: PermissionRequest) => Promise<PermissionDecision>;

export interface AgentRunResult {
  /** Every tool request that passed through `canUseTool`, in order. */
  readonly intercepted: PermissionRequest[];
  readonly allowed: string[];
  readonly denied: string[];
}

export interface AgentAdapter {
  run(prompt: string, canUseTool: CanUseTool): Promise<AgentRunResult>;
}

/**
 * Deterministic adapter for tests/CI: replays a fixed list of tool requests through `canUseTool`,
 * with no model call. Proves the interception + allow/deny contract the real adapter must honor.
 */
export function createFakeAgentAdapter(toolRequests: PermissionRequest[]): AgentAdapter {
  return {
    async run(_prompt: string, canUseTool: CanUseTool): Promise<AgentRunResult> {
      const intercepted: PermissionRequest[] = [];
      const allowed: string[] = [];
      const denied: string[] = [];
      for (const request of toolRequests) {
        intercepted.push(request);
        const decision = await canUseTool(request);
        if (decision.behavior === 'allow') {
          allowed.push(request.toolName);
        } else {
          denied.push(request.toolName);
        }
      }
      return { intercepted, allowed, denied };
    },
  };
}
