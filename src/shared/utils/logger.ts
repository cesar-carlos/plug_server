import { nowLogTimestamp } from "./date";

const serializeValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        serializeValue(v),
      ]),
    );
  }

  return value;
};

/** Set by `vitest.e2e.config.ts` to avoid flooding e2e runs with INFO lines (connections, rpc, etc.). */
const silenceE2eInfoLogs = (): boolean =>
  process.env.NODE_ENV === "test" && process.env.E2E_SILENCE_LOGS === "true";

const formatLogLine = (
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  message: string,
  context?: Record<string, unknown>,
): string => {
  const timestamp = nowLogTimestamp();
  const serializedContext = context
    ? ` ${JSON.stringify(serializeValue(context))}`
    : "";

  return `[${timestamp}] ${level} ${message}${serializedContext}`;
};

/* eslint-disable no-console */
export const logger = {
  info(message: string, context?: Record<string, unknown>): void {
    if (silenceE2eInfoLogs()) {
      return;
    }
    console.info(formatLogLine("INFO", message, context));
  },

  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(formatLogLine("WARN", message, context));
  },

  error(message: string, context?: Record<string, unknown>): void {
    console.error(formatLogLine("ERROR", message, context));
  },

  /** Development-only; no output in `test` or `production`. */
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== "development") {
      return;
    }
    console.debug(formatLogLine("DEBUG", message, context));
  },
};
