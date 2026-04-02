import { z } from "zod";
import { registrationOpaqueTokenSchema, uuidSchema } from "../../../shared/validators/schemas";

export const clientAgentIdsBodySchema = z.object({
  agentIds: z.array(uuidSchema).min(1).max(100),
});

export type ClientAgentIdsBody = z.infer<typeof clientAgentIdsBodySchema>;

export const clientAgentIdParamSchema = z.object({
  agentId: uuidSchema,
});

export type ClientAgentIdParam = z.infer<typeof clientAgentIdParamSchema>;

export const clientListAgentsQuerySchema = z.object({
  status: z.enum(["active", "inactive"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type ClientListAgentsQuery = z.infer<typeof clientListAgentsQuerySchema>;

export const clientListAgentAccessRequestsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type ClientListAgentAccessRequestsQuery = z.infer<
  typeof clientListAgentAccessRequestsQuerySchema
>;

export const clientAccessReviewTokenQuerySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type ClientAccessReviewTokenQuery = z.infer<typeof clientAccessReviewTokenQuerySchema>;

export const clientAccessApproveBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type ClientAccessApproveBody = z.infer<typeof clientAccessApproveBodySchema>;

export const clientAccessRejectBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
  reason: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().max(500).optional(),
  ),
});

export type ClientAccessRejectBody = z.infer<typeof clientAccessRejectBodySchema>;
