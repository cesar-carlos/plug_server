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

const formatLogLine = (
  level: "INFO" | "WARN" | "ERROR",
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
    console.info(formatLogLine("INFO", message, context));
  },

  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(formatLogLine("WARN", message, context));
  },

  error(message: string, context?: Record<string, unknown>): void {
    console.error(formatLogLine("ERROR", message, context));
  },
};
