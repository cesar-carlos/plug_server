/**
 * HTTP-specific validators for agent routes.
 * Re-exports transport-agnostic schemas from shared.
 */

import { z } from "zod";

export {
  agentCommandBodySchema,
  bridgeCommandSchema,
  type AgentCommandBody,
  type BridgeCommand,
  type PayloadFrameCompression,
} from "../../../shared/validators/agent_command";

export const listConnectedAgentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListConnectedAgentsQuery = z.infer<typeof listConnectedAgentsQuerySchema>;
