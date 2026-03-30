import { z } from "zod";

// ─── Primitives ──────────────────────────────────────────────────────────────

export const uuidSchema = z.string().uuid({ message: "Must be a valid UUID" });

/** Opaque registration approval token (base64url, 32 random bytes). */
export const registrationOpaqueTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, { message: "Invalid registration token format" });

export const emailSchema = z
  .string()
  .email({ message: "Must be a valid email address" })
  .toLowerCase();

export const passwordSchema = z
  .string()
  .min(8, { message: "Password must be at least 8 characters" })
  .max(128, { message: "Password must be at most 128 characters" })
  .regex(/[A-Z]/, { message: "Password must contain at least one uppercase letter" })
  .regex(/[0-9]/, { message: "Password must contain at least one number" });

export const usernameSchema = z
  .string()
  .min(3, { message: "Username must be at least 3 characters" })
  .max(32, { message: "Username must be at most 32 characters" })
  .regex(/^[a-zA-Z0-9_-]+$/, {
    message: "Username may only contain letters, numbers, underscores, and hyphens",
  });

export const isoDateSchema = z
  .string()
  .datetime({ message: "Must be a valid ISO 8601 datetime string" });

export const positiveIntSchema = z
  .number()
  .int({ message: "Must be an integer" })
  .positive({ message: "Must be a positive number" });

export const nonEmptyStringSchema = z.string().min(1, { message: "Must not be empty" }).trim();

// ─── Pagination ───────────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100, { message: "Limit must be at most 100" })
    .default(20),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

// ─── URL params ───────────────────────────────────────────────────────────────

export const idParamSchema = z.object({
  id: uuidSchema,
});

export type IdParam = z.infer<typeof idParamSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wraps an existing schema making the field optional but coercing empty strings to undefined.
 * Useful for optional query parameters that Express passes as empty strings.
 */
export const optionalString = (schema: z.ZodString): z.ZodOptional<z.ZodString> => {
  return schema.optional();
};
