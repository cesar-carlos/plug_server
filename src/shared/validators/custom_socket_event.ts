import { Buffer } from "node:buffer";

import { z } from "zod";

import { payloadFrameCompressionSchema, type PayloadFrameCompression } from "./agent_command";

export type { PayloadFrameCompression };

export const customSocketEventPrefix = "client:custom." as const;
export const customSocketEventNameMaxLength = 128;

const customSocketEventNamePattern = /^client:custom\.[A-Za-z0-9][A-Za-z0-9._:-]{0,113}$/;

export const customSocketEventNameSchema = z
  .string()
  .trim()
  .min(customSocketEventPrefix.length + 1)
  .max(customSocketEventNameMaxLength)
  .regex(
    customSocketEventNamePattern,
    "Event name must start with client:custom. and contain only letters, numbers, dot, colon, underscore or hyphen",
  );

export const socketEventSubscriptionSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    eventName: customSocketEventNameSchema,
  })
  .strict();

export const clientSocketEventPublishBodySchema = z
  .object({
    eventName: customSocketEventNameSchema,
    payload: z.unknown().refine((value) => value !== undefined, "payload is required"),
    payloadFrameCompression: payloadFrameCompressionSchema.optional(),
  })
  .strict();

const socketEventPublishIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "idempotencyKey may contain only letters, numbers, dot, colon, underscore or hyphen",
  );

/** Inline attachment for `socket:event.publish` (same logical shape as after Multer on REST). */
export const clientSocketEventAttachmentInputSchema = z
  .object({
    fieldName: z.string().trim().min(1).max(256),
    originalName: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(256),
    sizeBytes: z.number().int().nonnegative(),
    base64: z.string().min(1),
  })
  .strict();

/**
 * Consumer `socket:event.publish` payload (JSON). Correlates with {@link socketEvents.socketEventPublished}.
 */
export const socketEventPublishRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    idempotencyKey: socketEventPublishIdempotencyKeySchema.optional(),
    eventName: customSocketEventNameSchema,
    payload: z.unknown().refine((value) => value !== undefined, "payload is required"),
    payloadFrameCompression: payloadFrameCompressionSchema.optional(),
    attachments: z.array(clientSocketEventAttachmentInputSchema).optional(),
  })
  .strict();

export type SocketEventPublishRequest = z.infer<typeof socketEventPublishRequestSchema>;

export const toClientSocketEventPublishInput = (
  req: SocketEventPublishRequest,
): ClientSocketEventPublishInput => ({
  eventName: req.eventName,
  payload: req.payload,
  ...(req.payloadFrameCompression !== undefined
    ? { payloadFrameCompression: req.payloadFrameCompression }
    : {}),
  attachments: req.attachments ?? [],
});

export interface ClientSocketEventAttachment {
  readonly fieldName: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly base64: string;
}

export interface ClientSocketEventPublishInput {
  readonly eventName: string;
  readonly payload: unknown;
  readonly payloadFrameCompression?: PayloadFrameCompression;
  readonly attachments: readonly ClientSocketEventAttachment[];
}

export type SocketEventSubscriptionPayload = z.infer<typeof socketEventSubscriptionSchema>;
export type ClientSocketEventPublishBody = z.infer<typeof clientSocketEventPublishBodySchema>;

export const jsonUtf8ByteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Like {@link jsonUtf8ByteLength} but returns `null` when serialization fails (e.g. circular refs). */
export const jsonUtf8ByteLengthOrNull = (value: unknown): number | null => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
};

export const toSocketEventAttachment = (
  file: Pick<Express.Multer.File, "fieldname" | "originalname" | "mimetype" | "size" | "buffer">,
): ClientSocketEventAttachment => ({
  fieldName: file.fieldname,
  originalName: file.originalname,
  mimeType: file.mimetype,
  sizeBytes: file.size,
  base64: file.buffer.toString("base64"),
});
