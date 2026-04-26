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

export const clientAgentAccessRequestIdParamSchema = z.object({
  requestId: uuidSchema,
});

export type ClientAgentAccessRequestIdParam = z.infer<
  typeof clientAgentAccessRequestIdParamSchema
>;

export const clientListAgentsQuerySchema = z.object({
  status: z.enum(["active", "inactive"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  refresh: z.coerce.boolean().optional(),
});

export type ClientListAgentsQuery = z.infer<typeof clientListAgentsQuerySchema>;

export const clientListAgentAccessRequestsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired", "revoked"]).optional(),
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

/**
 * Body for `PUT /api/v1/client/me/agents/{agentId}/client-token`.
 *
 * - `clientToken: string` — store/replace the per-(client, agent) bearer
 *   token. 1..512 chars to mirror the SQL bridge token validator and the DB
 *   column width (`client_agent_accesses.client_token VARCHAR(512)`).
 * - `clientToken: null` — explicitly clear the stored token.
 *
 * Empty strings are normalized to `null` so the client can post an emptied
 * input field from a form without a 400.
 */
export const clientAgentTokenBodySchema = z.object({
  clientToken: z.preprocess(
    (value) => {
      if (typeof value === "string" && value.trim() === "") {
        return null;
      }
      return value;
    },
    z.union([z.null(), z.string().min(1).max(512)]),
  ),
});

export type ClientAgentTokenBody = z.infer<typeof clientAgentTokenBodySchema>;
