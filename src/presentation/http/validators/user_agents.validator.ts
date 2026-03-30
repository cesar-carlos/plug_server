import { z } from "zod";
import { uuidSchema } from "../../../shared/validators/schemas";

export const agentIdsBodySchema = z.object({
  agentIds: z
    .array(uuidSchema)
    .min(1, { message: "At least one agentId is required" })
    .max(100, { message: "At most 100 agentIds per request" }),
});

export type AgentIdsBody = z.infer<typeof agentIdsBodySchema>;

export const userIdParamSchema = z.object({
  userId: uuidSchema,
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;
