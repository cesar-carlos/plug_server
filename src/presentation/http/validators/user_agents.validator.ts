import { z } from "zod";
import { uuidSchema } from "../../../shared/validators/schemas";

export const userIdParamSchema = z.object({
  userId: uuidSchema,
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

export const userListAgentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type UserListAgentsQuery = z.infer<typeof userListAgentsQuerySchema>;
