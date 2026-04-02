import { z } from "zod";
import { uuidSchema } from "../../../shared/validators/schemas";

export const userIdParamSchema = z.object({
  userId: uuidSchema,
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;
