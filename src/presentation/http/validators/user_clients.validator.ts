import { z } from "zod";

import { uuidSchema } from "../../../shared/validators/schemas";

export const userClientIdParamSchema = z.object({
  clientId: uuidSchema,
});

export type UserClientIdParam = z.infer<typeof userClientIdParamSchema>;

export const userAgentIdParamSchema = z.object({
  agentId: uuidSchema,
});

export type UserAgentIdParam = z.infer<typeof userAgentIdParamSchema>;

export const userAgentClientParamSchema = z.object({
  agentId: uuidSchema,
  clientId: uuidSchema,
});

export type UserAgentClientParam = z.infer<typeof userAgentClientParamSchema>;

export const userClientAccessRequestIdParamSchema = z.object({
  requestId: uuidSchema,
});

export type UserClientAccessRequestIdParam = z.infer<typeof userClientAccessRequestIdParamSchema>;

export const userListClientsQuerySchema = z.object({
  status: z.enum(["active", "blocked"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type UserListClientsQuery = z.infer<typeof userListClientsQuerySchema>;

export const userSetClientStatusBodySchema = z.object({
  status: z.enum(["active", "blocked"]),
});

export type UserSetClientStatusBody = z.infer<typeof userSetClientStatusBodySchema>;

export const userListClientAccessRequestsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
  search: z.string().max(120).optional(),
  agentId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type UserListClientAccessRequestsQuery = z.infer<typeof userListClientAccessRequestsQuerySchema>;

export const userRejectClientAccessRequestBodySchema = z.object({
  reason: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().max(500).optional(),
  ),
});

export type UserRejectClientAccessRequestBody = z.infer<typeof userRejectClientAccessRequestBodySchema>;

export const userListAgentClientsQuerySchema = z.object({
  status: z.enum(["active", "blocked"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type UserListAgentClientsQuery = z.infer<typeof userListAgentClientsQuerySchema>;
