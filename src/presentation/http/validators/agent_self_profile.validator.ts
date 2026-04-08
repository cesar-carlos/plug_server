import { z } from "zod";

import { uuidSchema } from "../../../shared/validators/schemas";

const normalizeOptionalText = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const normalizeRequiredText = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  return value.trim();
};

const optionalNullableText = (maxLength: number): z.ZodType<string | null | undefined> =>
  z.preprocess(normalizeOptionalText, z.string().max(maxLength).nullable().optional());

const optionalNameText = z.preprocess(normalizeRequiredText, z.string().min(1).max(120).optional());

const httpAddressPatchSchema = z
  .object({
    street: optionalNullableText(120),
    number: optionalNullableText(20),
    district: optionalNullableText(120),
    postalCode: optionalNullableText(20),
    city: optionalNullableText(120),
    state: optionalNullableText(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!Object.values(value).some((field) => field !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one address field must be provided",
        path: [],
      });
    }
  });

const socketAddressPatchSchema = z
  .object({
    street: optionalNullableText(120),
    number: optionalNullableText(20),
    district: optionalNullableText(120),
    postal_code: optionalNullableText(20),
    city: optionalNullableText(120),
    state: optionalNullableText(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!Object.values(value).some((field) => field !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one address field must be provided",
        path: [],
      });
    }
  });

const ensurePatchHasFields = (
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  ignoredKeys: readonly string[] = [],
): void => {
  const hasFields = Object.entries(value).some(([key, fieldValue]) => {
    if (ignoredKeys.includes(key)) {
      return false;
    }

    return fieldValue !== undefined;
  });

  if (!hasFields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one mutable profile field must be provided",
      path: [],
    });
  }
};

export const agentSelfProfileParamsSchema = z.object({
  agentId: uuidSchema,
});

export type AgentSelfProfileParams = z.infer<typeof agentSelfProfileParamsSchema>;

export const agentSelfProfileHttpBodySchema = z
  .object({
    name: optionalNameText,
    tradeName: optionalNullableText(120),
    document: optionalNullableText(40),
    documentType: z.enum(["cpf", "cnpj"]).nullable().optional(),
    phone: optionalNullableText(20),
    mobile: optionalNullableText(20),
    email: z.preprocess(normalizeOptionalText, z.string().email().max(255).nullable().optional()),
    address: z.union([httpAddressPatchSchema, z.null()]).optional(),
    notes: optionalNullableText(2000),
    /** CAS: must match current server profileVersion when provided. */
    expectedProfileVersion: z.number().int().min(0).optional(),
    /** Optional idempotency key when `Idempotency-Key` header is not sent. */
    idempotencyKey: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    ensurePatchHasFields(value, ctx, ["expectedProfileVersion", "idempotencyKey"]);
  });

export type AgentSelfProfileHttpBody = z.infer<typeof agentSelfProfileHttpBodySchema>;

export const agentSelfProfileSocketSchema = z
  .object({
    agent_id: uuidSchema.optional(),
    name: optionalNameText,
    trade_name: optionalNullableText(120),
    document: optionalNullableText(40),
    document_type: z.enum(["cpf", "cnpj"]).nullable().optional(),
    phone: optionalNullableText(20),
    mobile: optionalNullableText(20),
    email: z.preprocess(normalizeOptionalText, z.string().email().max(255).nullable().optional()),
    address: z.union([socketAddressPatchSchema, z.null()]).optional(),
    notes: optionalNullableText(2000),
    profile_version: z.number().int().min(0).optional(),
    expected_profile_version: z.number().int().min(0).optional(),
    idempotency_key: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    ensurePatchHasFields(value as Record<string, unknown>, ctx, [
      "agent_id",
      "profile_version",
      "expected_profile_version",
      "idempotency_key",
    ]);
  });

export type AgentSelfProfileSocketBody = z.infer<typeof agentSelfProfileSocketSchema>;
