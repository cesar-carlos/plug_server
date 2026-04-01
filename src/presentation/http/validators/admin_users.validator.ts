import { z } from "zod";

import { uuidSchema } from "../../../shared/validators/schemas";

export const adminUserIdParamSchema = z.object({
  id: uuidSchema,
});

export const adminSetUserStatusBodySchema = z.object({
  status: z.enum(["active", "blocked"]),
});

export type AdminUserIdParam = z.infer<typeof adminUserIdParamSchema>;
export type AdminSetUserStatusBody = z.infer<typeof adminSetUserStatusBodySchema>;
