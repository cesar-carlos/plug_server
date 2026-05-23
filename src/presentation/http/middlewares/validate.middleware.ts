import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import type { ZodTypeAny } from "zod";

type RequestSchemas = {
  readonly body?: ZodTypeAny;
  readonly params?: ZodTypeAny;
  readonly query?: ZodTypeAny;
};

/**
 * Typed accessor for validated request data stored in `response.locals.validated`.
 * Use `z.infer<typeof mySchema>` as the generic to get fully typed values.
 *
 * @example
 * const body = getValidated<z.infer<typeof loginBodySchema>>(response, "body");
 */
export const getValidated = <T>(response: Response, key: keyof RequestSchemas): T => {
  const validated = response.locals.validated as Record<string, unknown>;
  return validated[key] as T;
};

/**
 * Middleware factory that validates request body, params, and/or query against
 * Zod schemas. On failure, propagates the `ZodError` via `next(error)` so the
 * centralized error middleware maps it to a 400 response.
 *
 * Validated data is stored in `response.locals.validated` and accessible
 * through `getValidated()` in downstream controllers.
 */
export const validateRequest = (schemas: RequestSchemas) => {
  return (request: Request, response: Response, next: NextFunction): void => {
    const validated: Record<string, unknown> = {};

    if (schemas.body) {
      const bodyResult = schemas.body.safeParse(request.body);
      if (!bodyResult.success) {
        next(bodyResult.error);
        return;
      }
      validated.body = bodyResult.data;
      request.body = bodyResult.data;
    }

    if (schemas.params) {
      const paramsResult = schemas.params.safeParse(request.params);
      if (!paramsResult.success) {
        next(paramsResult.error);
        return;
      }
      validated.params = paramsResult.data;
    }

    if (schemas.query) {
      const queryResult = schemas.query.safeParse(request.query);
      if (!queryResult.success) {
        next(queryResult.error);
        return;
      }
      validated.query = queryResult.data;
    }

    response.locals.validated = validated;

    next();
  };
};

/**
 * Normalizes ZodError issues into a flat, client-friendly array.
 *
 * @example
 * [{ field: "email", message: "Must be a valid email address" }]
 */
export const normalizeZodIssues = (
  error: z.ZodError,
): Array<{ field: string; message: string }> => {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "root",
    message: issue.message,
  }));
};
