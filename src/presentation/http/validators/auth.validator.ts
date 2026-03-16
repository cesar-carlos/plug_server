import { z } from "zod";
import { emailSchema, nonEmptyStringSchema, passwordSchema } from "../../../shared/validators/schemas";

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: emailSchema,
  password: nonEmptyStringSchema,
});

export type LoginBody = z.infer<typeof loginBodySchema>;

export const refreshBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const logoutBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type LogoutBody = z.infer<typeof logoutBodySchema>;
