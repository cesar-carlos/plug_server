import { parsePhoneNumberFromString } from "libphonenumber-js";
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

/**
 * Brazilian mobile (celular), normalized to E.164. Rejects landlines and invalid numbers.
 *
 * Rule (national significant number without country code `55`): length 11, digit at index 2 is `9`
 * (mobile prefix after 2-digit area code). Landlines use 8 local digits (10-digit national) or
 * local part not starting with 9 after DDD. Accepts international `+55…`, national with/without
 * punctuation; output is always E.164.
 */
export const brazilianCelularSchema = z
  .string()
  .trim()
  .superRefine((val, ctx) => {
    const parsed = parsePhoneNumberFromString(val, "BR");
    if (!parsed?.isValid()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must be a valid Brazilian mobile number",
      });
      return;
    }
    const national = String(parsed.nationalNumber);
    // BR mobile: area code (2 digits) + 9 + 8 digits (11 national digits total).
    if (!(national.length === 11 && national[2] === "9")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must be a mobile (celular) number, not a landline",
      });
    }
  })
  .transform((val) => {
    const parsed = parsePhoneNumberFromString(val.trim(), "BR");
    return parsed!.format("E.164");
  });

/** Optional request field: empty/absent → undefined; otherwise validated BR mobile → E.164. */
export const optionalBrazilianCelularSchema = z.preprocess(
  (raw) => {
    if (raw === "" || raw === null || raw === undefined) return undefined;
    return typeof raw === "string" ? raw.trim() : String(raw).trim();
  },
  z.union([z.undefined(), brazilianCelularSchema]),
);

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
