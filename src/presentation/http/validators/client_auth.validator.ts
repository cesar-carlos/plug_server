import { z } from "zod";
import {
  brazilianCelularSchema,
  emailSchema,
  nonEmptyStringSchema,
  passwordSchema,
  registrationOpaqueTokenSchema,
} from "../../../shared/validators/schemas";

export const clientRegisterBodySchema = z.object({
  ownerEmail: emailSchema,
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

export const clientRegistrationTokenQuerySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type ClientRegistrationTokenQuery = z.infer<typeof clientRegistrationTokenQuerySchema>;

export const clientRegistrationApproveBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type ClientRegistrationApproveBody = z.infer<typeof clientRegistrationApproveBodySchema>;

export const clientRegistrationRejectBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
  reason: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().max(500).optional(),
  ),
});

export type ClientRegistrationRejectBody = z.infer<typeof clientRegistrationRejectBodySchema>;

/** Partial profile update for authenticated client. `null` clears optional fields. */
export const clientPatchMeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    lastName: z.string().trim().min(1).max(120).optional(),
    mobile: z.union([z.null(), brazilianCelularSchema]).optional(),
    thumbnailUrl: z.null().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one profile field must be provided",
  });

export type ClientPatchMeBody = z.infer<typeof clientPatchMeBodySchema>;

export const clientChangePasswordBodySchema = z
  .object({
    currentPassword: nonEmptyStringSchema,
    newPassword: passwordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from current password",
    path: ["newPassword"],
  });

export type ClientChangePasswordBody = z.infer<typeof clientChangePasswordBodySchema>;

export const clientPasswordRecoveryRequestBodySchema = z.object({
  email: emailSchema,
});

export type ClientPasswordRecoveryRequestBody = z.infer<typeof clientPasswordRecoveryRequestBodySchema>;

export const clientPasswordRecoveryTokenQuerySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type ClientPasswordRecoveryTokenQuery = z.infer<typeof clientPasswordRecoveryTokenQuerySchema>;

export const clientPasswordRecoveryResetBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
  newPassword: passwordSchema,
});

export type ClientPasswordRecoveryResetBody = z.infer<typeof clientPasswordRecoveryResetBodySchema>;
