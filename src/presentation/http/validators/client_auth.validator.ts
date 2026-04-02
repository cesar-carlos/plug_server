import { z } from "zod";
import {
  brazilianCelularSchema,
  emailSchema,
  nonEmptyStringSchema,
  passwordSchema,
} from "../../../shared/validators/schemas";

export const clientRegisterBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  mobile: z.union([z.undefined(), brazilianCelularSchema]),
});

export type ClientRegisterBody = z.infer<typeof clientRegisterBodySchema>;

export const clientLoginBodySchema = z.object({
  email: emailSchema,
  password: nonEmptyStringSchema,
});

export type ClientLoginBody = z.infer<typeof clientLoginBodySchema>;

export const clientRefreshBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type ClientRefreshBody = z.infer<typeof clientRefreshBodySchema>;

export const clientLogoutBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type ClientLogoutBody = z.infer<typeof clientLogoutBodySchema>;
