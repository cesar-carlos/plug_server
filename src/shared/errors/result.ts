import type { AppError } from "./app_error";

// ─── Result type ─────────────────────────────────────────────────────────────

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E extends AppError = AppError> = { readonly ok: false; readonly error: E };
export type Result<T, E extends AppError = AppError> = Ok<T> | Err<E>;

// ─── Constructors ─────────────────────────────────────────────────────────────

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E extends AppError>(error: E): Err<E> => ({ ok: false, error });

// ─── Guards ──────────────────────────────────────────────────────────────────

export const isOk = <T, E extends AppError>(result: Result<T, E>): result is Ok<T> =>
  result.ok === true;

export const isErr = <T, E extends AppError>(result: Result<T, E>): result is Err<E> =>
  result.ok === false;

// ─── Unwrap helpers ──────────────────────────────────────────────────────────

/**
 * Returns the value from Ok, or throws the error from Err.
 * Use only when you are certain the result is Ok or want to propagate the error.
 */
export const unwrap = <T, E extends AppError>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw result.error;
};

/**
 * Returns the value from Ok, or a fallback value from Err.
 */
export const unwrapOr = <T, E extends AppError>(result: Result<T, E>, fallback: T): T => {
  return result.ok ? result.value : fallback;
};
