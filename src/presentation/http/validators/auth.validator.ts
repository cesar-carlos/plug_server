import { z } from "zod";
import { emailSchema, nonEmptyStringSchema, passwordSchema } from "../../../shared/validators/schemas";

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type RegisterBody = z.infer<typeof registerBodySchema>;

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

export const refreshBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const logoutBodySchema = z.object({
  refreshToken: nonEmptyStringSchema.optional(),
});

export type LogoutBody = z.infer<typeof logoutBodySchema>;

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
