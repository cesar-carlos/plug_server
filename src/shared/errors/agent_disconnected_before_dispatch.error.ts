import type { AgentCommandBody } from "../validators/agent_command";

/**
 * Thrown by {@link dispatchRpcCommandToAgent} when the catalog agent exists
 * but has no live `/agents` socket (or the registry socket id is stale).
 * REST maps this to HTTP 200 + normalized JSON-RPC `agent_offline` (-32000);
 * Socket `agents:command` maps to `agents:command_response` with the same
 * normalized envelope (correlation ids only — pure notifications keep 503).
 */
export class AgentDisconnectedBeforeDispatchError extends Error {
  public readonly name = "AgentDisconnectedBeforeDispatchError";

  constructor(
    public readonly agentId: string,
    public readonly command: AgentCommandBody["command"],
  ) {
    super(`Agent ${agentId} is not connected`);
  }
}
