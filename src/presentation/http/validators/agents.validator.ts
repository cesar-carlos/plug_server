/**
 * HTTP-specific validators for agent routes.
 * Re-exports transport-agnostic schemas from shared.
 */

export {
  agentCommandBodySchema,
  bridgeCommandSchema,
  type AgentCommandBody,
  type BridgeCommand,
  type PayloadFrameCompression,
} from "../../../shared/validators/agent_command";
