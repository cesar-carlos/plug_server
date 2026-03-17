/**
 * Shared RPC type guards and converters for JSON-RPC 2.0 payloads.
 * Used across HTTP, Socket, and bridge layers to avoid duplication.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const toRequestId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
};

export type JsonRpcId = string | number | null;

export const toJsonRpcId = (value: unknown): JsonRpcId => {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null) {
    return null;
  }

  return null;
};
