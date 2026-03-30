import { z } from "zod";
import { uuidSchema, nonEmptyStringSchema } from "../../../shared/validators/schemas";

export const createAgentBodySchema = z.object({
  agentId: uuidSchema,
  name: nonEmptyStringSchema.max(120, { message: "Name must be at most 120 characters" }),
  cnpjCpf: nonEmptyStringSchema,
  observation: z
    .string()
    .max(2000, { message: "Observation must be at most 2000 characters" })
    .optional(),
});

export type CreateAgentBody = z.infer<typeof createAgentBodySchema>;

export const updateAgentBodySchema = z.object({
  name: z.string().min(1).max(120, { message: "Name must be at most 120 characters" }).optional(),
  cnpjCpf: z.string().min(1).optional(),
  observation: z
    .string()
    .max(2000, { message: "Observation must be at most 2000 characters" })
    .nullable()
    .optional(),
});

export type UpdateAgentBody = z.infer<typeof updateAgentBodySchema>;

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
