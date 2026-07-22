import { AppError } from "../../../../shared/errors/app_error";
import { isRecord } from "../../../../shared/utils/rpc_types";

/**
 * Correlation helpers for `relay:rpc.accepted { success: false }`.
 *
 * Consumers (e.g. Colmeia) index pending RPCs by JSON-RPC `id`
 * (`clientRequestId`). An error `accepted` without that field is ignored and
 * the pending future hangs until the local client timer fires.
 */

export const attachRelayClientRequestIdToAppError = (
  error: AppError,
  clientRequestId: string,
): AppError => {
  if (isRecord(error.details) && typeof error.details.clientRequestId === "string") {
    return error;
  }
  const baseDetails: Record<string, unknown> = isRecord(error.details)
    ? { ...error.details }
    : error.details !== undefined
      ? { detail: error.details }
      : {};
  return new AppError(error.message, {
    statusCode: error.statusCode,
    code: error.code,
    details: { ...baseDetails, clientRequestId },
  });
};

export const readRelayClientRequestIdFromError = (err: unknown): string | undefined => {
  if (!(err instanceof AppError) || !isRecord(err.details)) {
    return undefined;
  }
  const id = err.details.clientRequestId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};
