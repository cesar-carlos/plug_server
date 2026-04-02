import { z } from "zod";
import { uuidSchema } from "../../../shared/validators/schemas";

export const agentIdParamSchema = z.object({
  agentId: uuidSchema,
});

export type AgentIdParam = z.infer<typeof agentIdParamSchema>;

export const listAgentsQuerySchema = z.object({
  status: z.enum(["active", "inactive"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
