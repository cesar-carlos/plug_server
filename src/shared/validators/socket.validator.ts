import type { z } from "zod";
import type { ZodTypeAny } from "zod";

import { AppError } from "../errors/app_error";

export type SocketValidationResult<T> = { ok: true; data: T } | { ok: false; error: AppError };

/**
 * Validates a socket.io event payload against a Zod schema.
 * Returns a typed result instead of throwing, so the handler
 * can emit an error event back to the client without crashing.
 */
export const validateSocketPayload = <S extends ZodTypeAny>(
  schema: S,
  payload: unknown,
): SocketValidationResult<z.infer<S>> => {
  const result = schema.safeParse(payload);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    return {
      ok: false,
      error: new AppError("Socket event validation failed", {
        statusCode: 400,
        code: "SOCKET_VALIDATION_ERROR",
        details: issues,
      }),
    };
  }

  return { ok: true, data: result.data as z.infer<S> };
};
