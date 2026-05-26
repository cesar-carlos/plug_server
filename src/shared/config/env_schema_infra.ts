import { z } from "zod";

export const envInfraShape = {
  DATABASE_URL: z.string().min(1),
  /** Max attempts for transient Prisma transaction conflicts/deadlocks. `1` disables retry. */
  DATABASE_TRANSACTION_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** Initial backoff in ms for transaction retries. Later attempts use exponential backoff with small jitter. */
  DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(1_000).default(25),
  JWT_ACCESS_SECRET: z.string().min(16).default("change-me-access-development"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_SECRET: z.string().min(16).default("change-me-refresh-development"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().min(1).default("plug_server"),
  JWT_AUDIENCE: z.string().min(1).default("plug_clients"),
  /** Public HTTP base URL for registration approval links (no trailing slash). */
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  /** Receives registration approval / rejection emails. */
  ADMIN_EMAIL: z.string().email().default("cesar_carlos@msn.com"),
  SMTP_HOST: z.string().min(1).default("smtp-mail.outlook.com"),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  /** e.g. "Plug Server <you@outlook.com>". If empty, falls back to APP_NAME + SMTP_USER. */
  SMTP_FROM: z.string().default(""),
  /** Shorthand like JWT refresh: 7d, 24h, 30m. */
  APPROVAL_TOKEN_EXPIRES_IN: z.string().default("7d"),
  CLIENT_PASSWORD_RECOVERY_TOKEN_EXPIRES_IN: z.string().default("30m"),
  /**
   * When true (default in production), refuse to boot without SMTP_USER/SMTP_PASS.
   * Set to false only if you use another path to approve users (not recommended).
   */
  REQUIRE_SMTP_IN_PRODUCTION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * When true, registration emails are sent after the HTTP response path (fire-and-forget).
   * When false, POST /register awaits outbound mail (simpler for local debugging).
   */
  REGISTRATION_EMAIL_ASYNC: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Max attempts per registration email dispatch operation (including first attempt). */
  REGISTRATION_EMAIL_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  /** Delay (ms) between retries for registration email delivery attempts. */
  REGISTRATION_EMAIL_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1500),
  /** When true, registration emails are persisted in outbox and sent by background worker. */
  REGISTRATION_EMAIL_OUTBOX_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Poll interval for registration email outbox worker in milliseconds. */
  REGISTRATION_EMAIL_OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(60_000)
    .default(3_000),
  /** Max outbox rows processed per poll cycle. */
  REGISTRATION_EMAIL_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(25),
  /** Max delivery attempts per outbox row before dead-letter. */
  REGISTRATION_EMAIL_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  /** Base retry delay in milliseconds used for exponential backoff in the outbox worker. */
  REGISTRATION_EMAIL_OUTBOX_RETRY_BASE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(300_000)
    .default(5_000),
  /** Stale lock timeout in milliseconds; rows locked longer than this may be reclaimed. */
  REGISTRATION_EMAIL_OUTBOX_LOCK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  /**
   * Retention (days) for dead-letter rows in `registration_email_outbox`.
   * Set `0` to disable the cleanup (rows accumulate indefinitely).
   */
  REGISTRATION_EMAIL_OUTBOX_DEAD_LETTER_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(30),
  /**
   * Interval (minutes) of the dead-letter prune job. Coordinated across replicas
   * by an advisory lock. Default 1440 = daily.
   */
  REGISTRATION_EMAIL_OUTBOX_DEAD_LETTER_PRUNE_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10080)
    .default(1440),
  SWAGGER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  BRIDGE_LOG_JSONRPC_AUTO_ID: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Optional Redis URL for Socket rate-limit state shared across hub replicas.
   * Empty = in-memory per process. Sticky sessions are still required for Socket bridge state.
   */
  SOCKET_RATE_LIMIT_REDIS_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
} as const;
