import { z } from "zod";
import {
  brazilianCelularSchema,
  emailSchema,
  nonEmptyStringSchema,
  optionalBrazilianCelularSchema,
  passwordSchema,
  registrationOpaqueTokenSchema,
  uuidSchema,
} from "../../../shared/validators/schemas";

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  celular: optionalBrazilianCelularSchema,
});

export type RegisterBody = z.infer<typeof registerBodySchema>;

export const registrationTokenQuerySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type RegistrationTokenQuery = z.infer<typeof registrationTokenQuerySchema>;

export const registrationApproveBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
});

export type RegistrationApproveBody = z.infer<typeof registrationApproveBodySchema>;

export const registrationRejectBodySchema = z.object({
  token: registrationOpaqueTokenSchema,
  reason: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().trim().max(500).optional(),
  ),
});

export type RegistrationRejectBody = z.infer<typeof registrationRejectBodySchema>;

export const loginBodySchema = z
  .object({
    email: emailSchema.optional(),
    username: nonEmptyStringSchema.optional(),
    password: nonEmptyStringSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.username) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "Email or username is required",
      });
    }
  })
  .transform((value) => ({
    email: (value.email ?? value.username ?? "").trim().toLowerCase(),
    password: value.password,
    username: value.username?.trim(),
  }));

export type LoginBody = z.output<typeof loginBodySchema>;

export const agentLoginBodySchema = z
  .object({
    email: emailSchema.optional(),
    username: nonEmptyStringSchema.optional(),
    password: nonEmptyStringSchema,
    agentId: uuidSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.username) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "Email or username is required",
      });
    }
  })
  .transform((value) => ({
    email: (value.email ?? value.username ?? "").trim().toLowerCase(),
    password: value.password,
    agentId: value.agentId,
  }));

export type AgentLoginBody = z.output<typeof agentLoginBodySchema>;

export const refreshBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const logoutBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type LogoutBody = z.infer<typeof logoutBodySchema>;

/** Update profile: `celular` is required; send `null` to remove the stored number. */
export const patchMeBodySchema = z.object({
  celular: z.union([z.null(), brazilianCelularSchema]),
});

export type PatchMeBody = z.infer<typeof patchMeBodySchema>;

export const changePasswordBodySchema = z
  .object({
    currentPassword: nonEmptyStringSchema,
    newPassword: passwordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from current password",
    path: ["newPassword"],
  });

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
