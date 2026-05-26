import pino, { type Logger as PinoLogger } from "pino";

/**
 * Set by `vitest.e2e.config.mjs` to avoid flooding e2e runs with INFO lines
 * (connections, rpc, etc.). Preserved from the previous logger to keep CI logs
 * lean.
 */
const silenceE2eInfoLogs = (): boolean =>
  process.env.NODE_ENV === "test" && process.env.E2E_SILENCE_LOGS === "true";

const resolveLogLevel = (): pino.LevelWithSilentOrString => {
  const fromEnv = process.env.LOG_LEVEL?.trim();
  if (fromEnv) {
    return fromEnv as pino.LevelWithSilentOrString;
  }
  if (process.env.NODE_ENV === "test") {
    return "warn";
  }
  if (process.env.NODE_ENV === "development") {
    return "debug";
  }
  return "info";
};

/**
 * Single pino instance shared by the whole process. The default JSON output is
 * one line per log entry on stdout (parser-friendly for Loki/CloudWatch/Datadog);
 * `pino-pretty` formatting is intentionally not wired in to keep the binary path
 * fully asynchronous in production. Use `LOG_LEVEL=...` to tune verbosity.
 */
const pinoInstance: PinoLogger = pino({
  level: resolveLogLevel(),
  /**
   * Use ISO timestamps so existing log aggregators that parse the legacy
   * `[YYYY-MM-DD HH:mm:ss UTC]` prefix can pick up the new `time` field
   * without losing temporal ordering when both formats coexist during rollout.
   */
  timestamp: pino.stdTimeFunctions.isoTime,
  /**
   * Strip pid/hostname from every entry: the runtime adds no value to log
   * correlation (containers are ephemeral and identity is already carried by
   * `requestId` / `X-Hub-Instance-Id`).
   */
  base: null,
  /**
   * Serializers handle `Error` instances and arbitrary context the same way
   * the previous logger did, so call sites do not need changes.
   */
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
});

const log = (
  level: "info" | "warn" | "error" | "debug",
  message: string,
  context?: Record<string, unknown>,
): void => {
  if (level === "info" && silenceE2eInfoLogs()) {
    return;
  }
  if (context) {
    pinoInstance[level](context, message);
    return;
  }
  pinoInstance[level](message);
};

/**
 * Process-wide logger preserving the legacy API surface
 * (`logger.info(message, context?)` etc.) so call sites do not need rewrites.
 *
 * Output format is now JSON Lines, one event per line, suitable for direct
 * ingestion by structured log shippers. The legacy `[timestamp] LEVEL message
 * { ...context }` format was synchronous and allocation-heavy on every call;
 * pino writes via an asynchronous internal buffer.
 */
export const logger = {
  info(message: string, context?: Record<string, unknown>): void {
    log("info", message, context);
  },
  warn(message: string, context?: Record<string, unknown>): void {
    log("warn", message, context);
  },
  error(message: string, context?: Record<string, unknown>): void {
    log("error", message, context);
  },
  /** Development-only; no output in `test` or `production`. */
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== "development") {
      return;
    }
    log("debug", message, context);
  },
};
