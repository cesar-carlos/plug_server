import { ZodError } from "zod";

import { AppError } from "./app_error";
import { type Result, ok, err } from "./result";

// ─── Error message extraction ────────────────────────────────────────────────

/**
 * Extracts the richest possible error message from any unknown thrown value.
 *
 * Priority:
 *   1. AppError  → uses its own message directly
 *   2. ZodError  → joins all issue messages
 *   3. Error     → uses the native message
 *   4. string    → uses the string itself
 *   5. object    → JSON-serializes it for debugging
 *   6. fallback  → returns the provided fallback string
 */
export const extractErrorMessage = (
  error: unknown,
  fallback = "An unexpected error occurred",
): string => {
  if (error instanceof AppError) return error.message;

  if (error instanceof ZodError) {
    return error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
  }

  if (error instanceof Error) return error.message;

  if (typeof error === "string" && error.trim().length > 0) return error;

  if (error !== null && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  return fallback;
};

// ─── Sync wrapper ────────────────────────────────────────────────────────────

/**
 * Wraps a synchronous function in a try-catch and returns a typed Result.
 * Known AppErrors are forwarded as-is. Unknown errors are wrapped with the
 * best message extraction possible.
 *
 * @example
 * const result = tryCatch(() => JSON.parse(raw), "Failed to parse payload");
 * if (!result.ok) return next(result.error);
 */
export const tryCatch = <T>(
  fn: () => T,
  fallbackMessage = "An unexpected error occurred",
  options?: { statusCode?: number; code?: string },
): Result<T> => {
  try {
    return ok(fn());
  } catch (error: unknown) {
    if (error instanceof AppError) return err(error);

    return err(
      new AppError(extractErrorMessage(error, fallbackMessage), {
        statusCode: options?.statusCode ?? 500,
        code: options?.code ?? "INTERNAL_SERVER_ERROR",
        details: error instanceof Error ? error.stack : undefined,
      }),
    );
  }
};

// ─── Async wrapper ────────────────────────────────────────────────────────────

/**
 * Wraps an async function in a try-catch and returns a typed Result.
 *
 * @example
 * const result = await tryCatchAsync(() => userRepo.findById(id), "User lookup failed");
 * if (!result.ok) return next(result.error);
 */
export const tryCatchAsync = async <T>(
  fn: () => Promise<T>,
  fallbackMessage = "An unexpected error occurred",
  options?: { statusCode?: number; code?: string },
): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (error: unknown) {
    if (error instanceof AppError) return err(error);

    return err(
      new AppError(extractErrorMessage(error, fallbackMessage), {
        statusCode: options?.statusCode ?? 500,
        code: options?.code ?? "INTERNAL_SERVER_ERROR",
        details: error instanceof Error ? error.stack : undefined,
      }),
    );
  }
};
