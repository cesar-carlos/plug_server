import { isRecord } from "../utils/rpc_types";

export const SQL_OPERATION_TRANSPORT = {
  enabled: true,
  version: 1,
  structureGuard: 1,
  durableJournal: true,
  singleSourceTransaction: true,
  automaticReplay: false,
  maxSteps: 32,
  maxAffectedRows: 100000,
  timeoutMs: 300000,
} as const;

export const negotiateSqlOperations = (
  raw: unknown,
): {
  readonly structureGuard?: 1;
  readonly maxSteps: number;
  readonly maxAffectedRows: number;
  readonly timeoutMs: number;
} | null => {
  if (
    !isRecord(raw) ||
    Array.isArray(raw) ||
    raw.enabled !== true ||
    raw.version !== 1 ||
    raw.durableJournal !== true ||
    raw.singleSourceTransaction !== true ||
    raw.automaticReplay !== false
  )
    return null;
  const limit = (key: "maxSteps" | "maxAffectedRows" | "timeoutMs"): number | null => {
    const value = raw[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, SQL_OPERATION_TRANSPORT[key])
      : null;
  };
  const maxSteps = limit("maxSteps");
  const maxAffectedRows = limit("maxAffectedRows");
  const timeoutMs = limit("timeoutMs");
  return maxSteps !== null && maxAffectedRows !== null && timeoutMs !== null
    ? {
        maxSteps,
        maxAffectedRows,
        timeoutMs,
        ...(raw.structureGuard === 1 ? { structureGuard: 1 as const } : {}),
      }
    : null;
};
