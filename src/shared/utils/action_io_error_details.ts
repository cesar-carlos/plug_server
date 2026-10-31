import { isRecord } from "./rpc_types";

/** Public diagnostic metadata only; never copy native messages, payloads or credentials. */
export const actionIoErrorDetails = (
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> => {
  const details: Record<string, string | number | boolean | null> = {};
  if (!isRecord(value)) return details;
  for (const key of [
    "code",
    "capability",
    "reason",
    "failure_code",
    "phase",
    "origin",
    "diagnostic_id",
    "request_id",
    "execution_id",
    "message_id",
    "delivery_state",
    "recovery",
  ]) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0 && field.length <= 256) details[key] = field;
  }
  for (const key of ["effects_possible", "outcome_unknown", "retryable"]) {
    if (typeof value[key] === "boolean") details[key] = value[key];
  }
  const confirmed = value.confirmed_bytes;
  if (
    confirmed === null ||
    (typeof confirmed === "number" && Number.isSafeInteger(confirmed) && confirmed >= 0)
  )
    details.confirmed_bytes = confirmed;
  return Object.freeze(details);
};
