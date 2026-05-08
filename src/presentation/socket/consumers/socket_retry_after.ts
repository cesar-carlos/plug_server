import { resolveAgentRpcRetryAfterSeconds } from "../../http/serializers/agent_rpc_retry_after";
import { AppError } from "../../../shared/errors/app_error";

export const resolveAppErrorRetryAfterMs = (error: unknown): number | undefined => {
  if (!(error instanceof AppError)) {
    return undefined;
  }
  const details = error.details;
  if (
    typeof details === "object" &&
    details !== null &&
    "retry_after_ms" in details &&
    typeof (details as { retry_after_ms?: unknown }).retry_after_ms === "number"
  ) {
    return Math.max(0, Math.floor((details as { retry_after_ms: number }).retry_after_ms));
  }
  return undefined;
};

export const resolveRpcRetryAfterSeconds = (response: unknown): number | undefined => {
  const seconds = resolveAgentRpcRetryAfterSeconds(response);
  return seconds === null ? undefined : seconds;
};
