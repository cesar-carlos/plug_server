import type { Socket } from "socket.io";
import { z } from "zod";

import { requestAgentStreamPull } from "../hub/rpc_bridge";
import { socketEvents } from "../../../shared/constants/socket_events";
import { isRecord } from "../../../shared/utils/rpc_types";
import { AppError } from "../../../shared/errors/app_error";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";

const streamPullPayloadSchema = z
  .object({
    streamId: nonEmptyStringSchema.optional(),
    requestId: nonEmptyStringSchema.optional(),
    windowSize: z.coerce.number().int().positive().max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.streamId && !value.requestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["streamId"],
        message: "Provide streamId or requestId",
      });
    }
  });

type StreamPullResponsePayload =
  | { success: true; requestId: string; streamId: string; windowSize: number }
  | { success: false; error: { code: string; message: string; statusCode?: number } };

const emitStreamPullResponse = (socket: Socket, payload: StreamPullResponsePayload): void => {
  socket.emit(socketEvents.agentsStreamPullResponse, payload);
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, { message, code });
};

export const handleAgentsStreamPull = (socket: Socket, rawPayload: unknown): void => {
  if (!isRecord(rawPayload)) {
    emitAppError(socket, "agents:stream_pull payload must be an object");
    return;
  }

  const parsed = streamPullPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitStreamPullResponse(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  try {
    const result = requestAgentStreamPull({
      consumerSocketId: socket.id,
      ...(parsed.data.streamId ? { streamId: parsed.data.streamId } : {}),
      ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
      ...(parsed.data.windowSize !== undefined ? { windowSize: parsed.data.windowSize } : {}),
    });

    emitStreamPullResponse(socket, {
      success: true,
      requestId: result.requestId,
      streamId: result.streamId,
      windowSize: result.windowSize,
    });
  } catch (err: unknown) {
    const appError = err instanceof AppError ? err : undefined;
    const code = appError?.code ?? "STREAM_PULL_FAILED";
    const message = err instanceof Error ? err.message : "Failed to pull stream";
    const statusCode = appError?.statusCode;

    emitStreamPullResponse(socket, {
      success: false,
      error: {
        code,
        message,
        ...(typeof statusCode === "number" ? { statusCode } : {}),
      },
    });
  }
};
