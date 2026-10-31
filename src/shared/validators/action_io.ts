import { z } from "zod";

export const ACTION_IO_BLOCK_BYTES = 64 * 1024;
export const ACTION_IO_PAGE_BYTES = 256 * 1024;
const encodedBlockLength = 4 * Math.ceil(ACTION_IO_BLOCK_BYTES / 3);
// Only sextets with zero unused bits may precede padding in canonical base64.
const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

/** Validate without normalizing: an empty block remains a message, not EOF. */
export const actionIoBlockSchema = z
  .string()
  .max(encodedBlockLength)
  .superRefine((value, ctx) => {
    if (value.length > encodedBlockLength || !base64Pattern.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid canonical base64 block" });
      return;
    }
    if (Buffer.byteLength(value, "base64") > ACTION_IO_BLOCK_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid canonical base64 block or decoded size",
      });
    }
  });

export const actionIoConfigurationSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("faithful"),
    close_input: z.boolean(),
    initial_input_base64: actionIoBlockSchema.optional(),
  })
  .strict();

const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.string().min(1);
const contextShape = {
  client_token: identitySchema.optional(),
  clientToken: identitySchema.optional(),
  auth: identitySchema.optional(),
  trace_id: identitySchema.optional(),
  requested_by: identitySchema.optional(),
};
const executionShape = { ...contextShape, execution_id: identitySchema };
const messageShape = { ...executionShape, message_id: identitySchema, sequence: sequenceSchema };

export const actionIoSendInputParamsSchema = z
  .object({
    ...messageShape,
    data_base64: actionIoBlockSchema,
  })
  .strict();
export const actionIoCloseInputParamsSchema = z.object(messageShape).strict();
export const actionIoGetInputStatusParamsSchema = z
  .object({
    ...executionShape,
    message_id: identitySchema,
  })
  .strict();
export const actionIoReadParamsSchema = z
  .object({
    ...executionShape,
    after_sequence: sequenceSchema,
    max_bytes: z.number().int().min(ACTION_IO_BLOCK_BYTES).max(ACTION_IO_PAGE_BYTES),
    wait_ms: z.number().int().min(0).max(20000),
  })
  .strict();
export const actionCatalogParamsSchema = z
  .object({
    ...contextShape,
    page_size: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();
export const actionIoFindExecutionParamsSchema = z
  .object({
    ...contextShape,
    action_id: identitySchema,
    idempotency_key: identitySchema,
  })
  .strict();
