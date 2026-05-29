import dotenv from "dotenv";
import { z } from "zod";

import {
  defaultRestSocketEventHttpJsonBodyLimit,
  socketEventPublishRawJsonUpperBound,
} from "./client_socket_event_publish_limits";

dotenv.config();

/**
 * Colmeia clients use JWT `role=client` on `/consumers`. If `SOCKET_CONSUMER_ROLES` lists
 * only `user,admin` (common misconfiguration), append `client` and set `clientAppended`.
 */
export const parseSocketConsumerRolesValue = (
  raw: string,
): { readonly roles: readonly string[]; readonly clientAppended: boolean } => {
  const roles = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (roles.includes("client")) {
    return { roles, clientAppended: false };
  }
  return { roles: [...roles, "client"], clientAppended: true };
};

const nodeEnvForDefaults = process.env.NODE_ENV;

/** When unset in environment, production uses performance-oriented Socket.IO defaults. */
const isProductionNodeEnv = (): boolean => nodeEnvForDefaults === "production";

/** Language policy for the HTML page served at `GET /` (root landing). */
export type RootLandingLangConfig = "pt" | "en" | "auto";

const payloadSigningPreviousKeysSchema = z
  .string()
  .default("")
  .transform((raw, ctx): Record<string, string> => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON must be valid JSON",
      });
      return z.NEVER;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON must be a JSON object",
      });
      return z.NEVER;
    }

    const out: Record<string, string> = {};
    for (const [keyId, secret] of Object.entries(parsed)) {
      const normalizedKeyId = keyId.trim();
      if (normalizedKeyId === "" || typeof secret !== "string" || secret.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON entries must use non-empty key ids and string secrets",
        });
        return z.NEVER;
      }
      out[normalizedKeyId] = secret;
    }
    return out;
  });

const envSchema = z.object({
  APP_NAME: z.string().default("plug_server"),
  /**
   * Root landing (`GET /`) language: fixed `pt` / `en`, or `auto` from the request
   * `Accept-Language` header (defaults to Portuguese when ambiguous).
   */
  ROOT_LANDING_LANG: z.enum(["pt", "en", "auto"]).default("auto"),
  /**
   * Optional stable identifier for this hub process (e.g. pod name, UUID).
   * When non-empty, every Express response carries `X-Hub-Instance-Id` for
   * multi-replica correlation (sticky-session validation, log/Sentry triage).
   * Header is set globally by the `hubInstanceIdMiddleware`, so it appears on
   * REST, Swagger, `/metrics`, and 404 responses alike.
   */
  HUB_INSTANCE_ID: z.string().max(256).default(""),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CONTAINER_PERSISTENCE_MODE: z.enum(["auto", "memory", "prisma"]).default("auto"),
  CONTAINER_EMAIL_SENDER_MODE: z.enum(["auto", "noop", "smtp"]).default("auto"),
  /**
   * When true, Express `trust proxy` is set so `req.ip` and rate-limit keys use `X-Forwarded-For`
   * correctly behind nginx/reverse proxies. Defaults to true in production, false otherwise.
   */
  HTTP_TRUST_PROXY: z.preprocess(
    (val) => {
      if (val !== undefined && val !== "" && String(val).trim() !== "") {
        return String(val).trim().toLowerCase();
      }
      return isProductionNodeEnv() ? "true" : "false";
    },
    z.enum(["true", "false"]).transform((v) => v === "true"),
  ),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Allowed CORS origins. Use `*` to allow any origin (cookies disabled in this case).
   * Otherwise pass a single origin or comma-separated list (e.g.
   * `https://app.example.com,https://admin.example.com`).
   * In production, `*` is rejected at boot.
   */
  CORS_ORIGIN: z.string().default("*"),
  REQUEST_BODY_LIMIT: z.string().default("1mb"),
  /**
   * Node.js `http.Server.requestTimeout` in ms — maximum time the server waits
   * for a complete HTTP request (headers + body). Protects against slow-loris
   * and hung connections. Default: 60 s. Set to 0 to disable.
   */
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),
  UPLOADS_DIR: z.string().default("uploads"),
  UPLOADS_PUBLIC_BASE_URL: z.preprocess((val) => {
    if (val !== undefined && String(val).trim() !== "") {
      return String(val).trim();
    }
    return `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/uploads`;
  }, z.string().url()),
  CLIENT_THUMBNAIL_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  CLIENT_THUMBNAIL_WIDTH: z.coerce.number().int().positive().max(4096).default(256),
  CLIENT_THUMBNAIL_HEIGHT: z.coerce.number().int().positive().max(4096).default(256),
  CLIENT_THUMBNAIL_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  REST_CLIENT_THUMBNAIL_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** `0` = unlimited (middleware skips counting). */
  REST_CLIENT_THUMBNAIL_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(20),
  /** Global rate-limit applied to every `/api/v1` request (per IP). */
  REST_GLOBAL_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  /** `0` = unlimited. */
  REST_GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(300),
  /**
   * Per-IP rate-limit for credential-handling endpoints (password-based):
   * `/login`, `/register`, `/agent-login`, `/registration/*`, `/password-recovery/*`, `/logout`.
   * Token rotation (`POST .../refresh`) uses `REST_TOKEN_REFRESH_RATE_LIMIT_*` instead.
   */
  REST_CREDENTIAL_AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  /** `0` = unlimited. */
  REST_CREDENTIAL_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(25),
  /**
   * Per-IP rate-limit for `POST /auth/refresh` and `POST /client-auth/refresh` only.
   * Higher defaults than credential routes so many agents behind one NAT can rotate access tokens after outages.
   */
  REST_TOKEN_REFRESH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  /** `0` = unlimited. */
  REST_TOKEN_REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(400),
  /**
   * Optional Redis URL for HTTP rate limits (`express-rate-limit` + `rate-limit-redis`).
   * Empty = default in-memory store (per process). Set when multiple hub replicas share HTTP limits.
   */
  REST_RATE_LIMIT_REDIS_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /** Per client JWT `sub` on `POST /api/v1/client/me/agents`. */
  REST_CLIENT_ME_AGENTS_POST_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),
  /** `0` = unlimited. */
  REST_CLIENT_ME_AGENTS_POST_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(60),
  REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** `0` = unlimited. */
  REST_SOCKET_EVENT_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(120),
  REST_SOCKET_EVENT_MAX_FILES: z.coerce.number().int().min(0).max(32).default(5),
  REST_SOCKET_EVENT_FILE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(512 * 1024),
  REST_SOCKET_EVENT_TOTAL_FILES_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(512 * 1024),
  /** `0` = do not cap local recipient fan-out for one custom socket event publish. */
  REST_SOCKET_EVENT_MAX_RECIPIENTS: z.coerce.number().int().min(0).max(1_000_000).default(0),
  /**
   * When distributed recipient counting fails with Redis adapter active, still allow best-effort
   * emits only while the local room size stays at or below this conservative cap.
   */
  REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(256),
  /**
   * Consecutive distributed count failures before the local best-effort circuit opens and the hub
   * starts rejecting `client:custom.*` publishes with `503`.
   */
  REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(5),
  /**
   * How long the local circuit for distributed room-count failures stays open after the threshold
   * is reached. While open, publishes that require distributed counting fail fast with `503`.
   */
  REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_OPEN_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(30_000),
  /**
   * Hint `retry_after_ms` when local fan-out exceeds {@link REST_SOCKET_EVENT_MAX_RECIPIENTS} (REST or Socket publish).
   * Independent from `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS` (rate limit window is unrelated to subscription churn).
   */
  REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(2_000),
  /** `0` = disable REST socket event idempotency cache. */
  REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(300_000),
  REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(10_000),
  /**
   * Max distinct `(clientId, idempotencyKey)` serialization chains tracked at once on this process.
   * `0` = unlimited. When exceeded, new **distinct** keys receive `503` until in-flight publishes complete.
   * Does not replace cross-replica coordination (see scaling docs).
   */
  REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(0),
  /**
   * Optional Redis URL for distributed idempotency of `client:custom.*` publishes.
   * Empty = local in-memory replay/serialization only.
   */
  REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /** TTL for the Redis SET NX lock protecting one distributed idempotency key while publish is in-flight. */
  REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(5_000),
  /**
   * How long a contender waits for another replica to write the idempotent response
   * before returning retryable 503. `0` = fail fast.
   */
  REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_WAIT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(30_000)
    .default(750),
  /**
   * Renew the Redis SET NX lock every `LOCK_RENEWAL_MS` while a publish is in-flight
   * (Redlock-style watchdog). Default `0` keeps legacy fixed-TTL behaviour. Recommended
   * value: ~`LOCK_TTL_MS / 3` so two failed renewals still leave headroom before expiry.
   * The watchdog stops when the publish completes or the lock is released.
   */
  REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_RENEWAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(0),
  /**
   * Optional read-replica URL for the idempotency `getEntry` path. When set,
   * `getEntry` queries the replica (cheap GET) while writes (`setEntry`,
   * `acquireLock`, `releaseLock`, `extendLock`) keep going to the primary.
   * Empty (default) = read from the primary client.
   *
   * Caveats: replica replication lag means `getEntry` may briefly return
   * `undefined` for a recently written key. The publish path tolerates this
   * because the post-lock `getEntry` recheck still happens against the
   * primary client.
   */
  REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_READ_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * Express `express.json` limit for JSON-only `POST /api/v1/client/me/socket-events` (not global).
   * Empty: derive ~110% of worst-case UTF-8 envelope from `REST_SOCKET_EVENT_*` payload + attachment caps.
   */
  REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * Optional fixed-window (ms) for `socket:event.publish` only. When unset/empty, mirrors
   * `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS` (same default, separate counter bucket).
   */
  SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_WINDOW_MS: z.preprocess(
    (val) =>
      val === undefined || val === null || String(val).trim() === ""
        ? undefined
        : Number(String(val).trim()),
    z.number().int().positive().optional(),
  ),
  /**
   * Optional max publishes per `socket:event.publish` window per client JWT `sub`.
   * When unset/empty, mirrors `REST_SOCKET_EVENT_RATE_LIMIT_MAX`.
   */
  SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_MAX: z.preprocess(
    (val) =>
      val === undefined || val === null || String(val).trim() === ""
        ? undefined
        : Number(String(val).trim()),
    z.number().int().min(0).max(10_000_000).optional(),
  ),
  /**
   * When > 0, a second `POST /client/me/agents` for the same agent while the request is still `pending`
   * and `requestedAt` is within this many ms does not re-email the owner (returns `debounced`).
   * `0` disables debouncing.
   */
  CLIENT_AGENT_ACCESS_REQUEST_EMAIL_DEBOUNCE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(0),
  /**
   * Maximum number of times a client can retry an agent access request after rejection/expiry/revocation.
   * `0` disables the limit (unlimited retries).
   */
  CLIENT_AGENT_ACCESS_MAX_RETRIES: z.coerce.number().int().min(0).default(5),
  REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300_000),
  /** `0` = unlimited. */
  REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(10),
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
  /**
   * In-memory cache of `verifyAccessToken` results. Cuts repeated jwt.verify
   * passes for the same token (typical on chatty Socket.IO sessions where
   * every event re-validates). `0` disables; defaults to 30s. Cache hits still
   * re-check the JWT `exp` claim before returning the payload, so an expiring
   * token is never served past its lifetime.
   */
  JWT_VERIFY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  JWT_VERIFY_CACHE_MAX_SIZE: z.coerce.number().int().min(0).max(50_000).default(2_000),
  /**
   * TTL for the `/metrics` response Buffer cache. On a cache hit the endpoint
   * skips the (synchronous) Prometheus render of thousands of lines. Default
   * 500ms collapses bursts from a single scraper; raise it on busy hubs with
   * aggressive scrape intervals to keep the heavy render off user-facing
   * requests. `0` disables the cache (every scrape re-renders).
   */
  METRICS_RESPONSE_CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  /**
   * Opt-in flag for OpenTelemetry auto-instrumentation of HTTP/Express/Prisma.
   * When enabled, the SDK is bootstrapped before `createApp` and emits spans
   * to the OTLP HTTP endpoint configured by `OTEL_EXPORTER_OTLP_ENDPOINT`
   * (default `http://localhost:4318`). Sampling rate is `OTEL_TRACES_SAMPLER_ARG`.
   */
  OTEL_TRACES_ENABLED: z.preprocess(
    (val) => {
      if (val !== undefined && val !== "" && String(val).trim() !== "") {
        return String(val).trim().toLowerCase();
      }
      return "false";
    },
    z.enum(["true", "false"]).transform((v) => v === "true"),
  ),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.05),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  OTEL_SERVICE_NAME: z.string().default("plug_server"),
  /**
   * When `true` AND `OTEL_TRACES_ENABLED=true`, the Redis-backed modules
   * wrap hot-path commands (Lua eval, XADD, SET NX) in named spans with
   * `module` and `op` attributes. Default `false` keeps the SDK
   * auto-instrumentation as the only source of Redis spans.
   *
   * Useful when investigating a slow `client:custom.*` publish: the named
   * spans expose which Lua script / Redis op contributed to the latency
   * tail without grepping auto-instrumentation generic spans.
   */
  REDIS_OTEL_SPANS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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
   * Max number of parallel SMTP sends per outbox flush. Default 4 (legacy),
   * generous profile recommends 8 when SMTP provider/connection pool tolerates it.
   * The actual concurrency is `Math.min(WORKER_CONCURRENCY, BATCH_SIZE)`.
   */
  REGISTRATION_EMAIL_OUTBOX_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * Retention (days) for dead-letter rows in `registration_email_outbox`
   * (rows where `attempts >= MAX_ATTEMPTS`, marked with `last_error` prefix
   * `max_attempts_reached:`). After this many days they are permanently deleted.
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
  PAYLOAD_SIGNING_KEY: z.string().optional(),
  PAYLOAD_SIGNING_KEY_ID: z.string().optional(),
  PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON: payloadSigningPreviousKeysSchema,
  PAYLOAD_SIGN_OUTBOUND: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Min UTF-8 bytes of serialized JSON before `encodePayloadFrame` / `encodePayloadFrameBridge`
   * attempt gzip. Smaller frames use `cmp: none` (avoids gzip+base64 CPU on tiny payloads).
   * Aligned with `HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES` (4096) unless overridden.
   */
  PAYLOAD_FRAME_COMPRESS_MIN_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024)
    .default(4096),
  /**
   * Max UTF-8 bytes of JSON before hub attempts gzip in `preencodePayloadFrameJson`.
   * Larger logical payloads are sent with `cmp: none` (still within 10 MiB frame limits).
   */
  PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(512 * 1024),
  /** Optional zlib level 1–9 for PayloadFrame gzip (unset = Node default ~6). Lower = faster CPU, larger wire. */
  PAYLOAD_FRAME_GZIP_LEVEL: z.preprocess(
    (val) => {
      if (val !== undefined && val !== "") {
        return val;
      }
      return isProductionNodeEnv() ? "3" : undefined;
    },
    z.preprocess(
      (val) => (val === undefined || val === "" ? undefined : val),
      z.coerce.number().int().min(1).max(9).optional(),
    ),
  ),
  /**
   * In auto mode, only keep gzip when it saves at least this many bytes versus raw UTF-8.
   * Avoids paying CPU for medium payloads whose compression win is negligible.
   */
  PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(64 * 1024)
    .default(64),
  /**
   * When > 0, hub→agent `encodePayloadFrameBridge` uses async zlib for gzip-eligible JSON at least this many UTF-8 bytes
   * (offloads CPU from the event loop). 0 = always synchronous gzip (previous behaviour).
   */
  PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024)
    .default(131_072),
  /**
   * When > 0 and `cmp === gzip`, inbound `decodePayloadFrameAsync` uses async gunzip for compressed payloads
   * at least this many bytes. 0 = always synchronous gunzip.
   */
  PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024)
    .default(65_536),
  /** Max rows accepted in one `sql.bulkInsert` RPC before the hub asks callers to chunk. */
  AGENT_SQL_BULK_INSERT_MAX_ROWS: z.coerce.number().int().positive().max(1_000_000).default(50_000),
  /** Max UTF-8 bytes for serialized `sql.bulkInsert.params` before PayloadFrame encoding. */
  AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  SOCKET_AGENT_INBOUND_CONTRACT_VALIDATION: z.enum(["strict", "warn", "off"]).default("strict"),
  SOCKET_AGENT_ACK_RETRY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SOCKET_AGENT_ACK_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),
  SOCKET_AGENT_ACK_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(1),
  /**
   * Max entries in `agentRegistry` known-agent set (offline IDs retained for REST 503 vs 404). 0 = unlimited.
   * When exceeded, removes known IDs that are not currently connected until under the cap.
   */
  SOCKET_AGENT_KNOWN_IDS_MAX: z.coerce.number().int().min(0).max(10_000_000).default(0),
  /**
   * Max concurrent `agent.getProfile` catalog sync RPCs kicked off after `agent:register`
   * (limits stampedes when many agents reconnect).
   */
  SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT: z.coerce.number().int().min(1).max(500).default(8),
  /**
   * Grace window after `agent:register` before the hub dispatches the first RPC to that agent.
   * If the agent sends `agent:heartbeat` earlier, the hub clears the wait immediately.
   */
  SOCKET_AGENT_PROTOCOL_READY_GRACE_MS: z.coerce.number().int().min(0).max(5_000).default(100),
  /**
   * When a second socket completes `agent:register` for the same `agentId` (same owner):
   * `reject_active` — refuse registration while another canonical socket is connected;
   * `takeover_disconnect_previous` — replace registry entry and disconnect the previous socket;
   * `legacy_silent_takeover` — replace registry mapping without forcing disconnect (legacy hub behaviour).
   */
  SOCKET_AGENT_SESSION_POLICY: z
    .enum(["reject_active", "takeover_disconnect_previous", "legacy_silent_takeover"])
    .default("reject_active"),
  /**
   * Sliding window for rate-limiting `agent:register` attempts per `(userId, agentId)` pair.
   * `0` on window or max disables this limiter (recommended default).
   */
  SOCKET_AGENT_REGISTER_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(0),
  /** Max `agent:register` attempts per window per `(userId, agentId)`. `0` disables. */
  SOCKET_AGENT_REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(100_000).default(0),
  /**
   * Optional Redis URL for Socket rate-limit state shared across hub replicas.
   * Empty = in-memory per process. Sticky sessions are still required for Socket bridge state.
   */
  SOCKET_RATE_LIMIT_REDIS_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * Default `node-redis` socket connect timeout (ms) shared by every Redis-backed module
   * (rate-limits + idempotency). The Socket.IO adapter keeps its own override for backwards
   * compatibility (`SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS`).
   */
  REDIS_DEFAULT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(5_000),
  /** Base delay (ms) for capped exponential backoff on reconnect attempts. */
  REDIS_DEFAULT_RECONNECT_BASE_MS: z.coerce.number().int().positive().max(60_000).default(200),
  /** Maximum delay (ms) between reconnect attempts. */
  REDIS_DEFAULT_RECONNECT_MAX_MS: z.coerce.number().int().positive().max(600_000).default(5_000),
  /**
   * Consecutive Redis command failures before the rate-limit modules open a
   * short local circuit (fail-open to the in-memory limiter). Shared by the
   * socket and REST rate-limit modules. `0` disables the circuit breaker.
   */
  REDIS_RATE_LIMIT_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(0).max(1_000).default(3),
  /** How long (ms) the rate-limit Redis circuit stays open before retrying. */
  REDIS_RATE_LIMIT_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().max(600_000).default(5_000),
  /**
   * When `true` and `NODE_ENV=production`, refuse to boot if any *_REDIS_URL uses plain
   * `redis://` without password. Use `rediss://` (TLS) or `redis://default:<password>@host`
   * instead. Default `false` keeps current behavior.
   */
  STRICT_REDIS_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Optional tenant identifier embedded in every Redis key prefix after the
   * `{plug}` hash tag. Used when multiple plug deployments share a single
   * Redis database and need hard isolation of rate-limit counters,
   * idempotency entries, and stream backlogs. Empty (default) keeps the
   * single-tenant key shape (no `<tenant>:` segment).
   *
   * Allowed: `[A-Za-z0-9_-]{1,32}`. Validated at boot.
   */
  REDIS_TENANT_ID: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z
      .string()
      .max(32)
      .refine((v) => v === "" || /^[A-Za-z0-9_-]+$/.test(v), {
        message: "REDIS_TENANT_ID must match /^[A-Za-z0-9_-]{1,32}$/ when set",
      }),
  ),
  /**
   * Optional Redis Streams URL for at-least-once delivery of `client:custom.*` frames
   * to agents that briefly disconnect/reconnect across hub replicas. Empty = streams
   * disabled (current pub/sub-only behaviour).
   */
  AGENT_EVENT_STREAM_REDIS_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * When `true`, append outbound `client:custom.*` frames to the per-agent Redis
   * stream so agents that reconnect retrieve a backlog. Default `false` (opt-in).
   */
  AGENT_EVENT_STREAM_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Cap per-agent stream length via `XADD MAXLEN ~ N`. Older entries are trimmed automatically. */
  AGENT_EVENT_STREAM_MAX_LEN: z.coerce.number().int().positive().max(1_000_000).default(1_000),
  /**
   * TTL applied to a per-agent stream key whenever a frame is appended. When the agent
   * goes idle longer than this, the entire stream is GC'd. `0` = never expire.
   */
  AGENT_EVENT_STREAM_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60 * 1_000)
    .default(24 * 60 * 60 * 1_000),
  /** Max entries returned per `XREAD` when reading the backlog on connect/resume. */
  AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(500),
  /**
   * CSV allowlist of principal ids (consumer Client `JWT sub`) for which the
   * durable backlog is enabled. Empty (default) = all recipients participate
   * when `AGENT_EVENT_STREAM_ENABLED=true`. Use this to roll out gradually.
   */
  AGENT_EVENT_STREAM_AGENT_ALLOWLIST: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * Drain-on-connect ack timeout (ms). When the agent socket does not ack a
   * backlog frame within this window the cursor is NOT committed and the
   * frame is left for the next reconnect attempt.
   */
  AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(5_000),
  /**
   * When `true`, the backlog drain uses Redis consumer groups (XREADGROUP /
   * XACK) instead of cursor-based XREAD / XDEL. Consumer groups coordinate
   * delivery across replicas so two hubs reconnecting the same principal
   * cannot deliver duplicate frames. Default `false` keeps the cursor-based
   * path for back-compat — see ADR-0007 (Sprint 12).
   */
  AGENT_EVENT_STREAM_USE_CONSUMER_GROUPS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Consumer group name shared across replicas. Single value per cluster.
   * Customise only if you run multiple hub clusters off the same Redis.
   */
  AGENT_EVENT_STREAM_CONSUMER_GROUP: z.string().min(1).max(64).default("plug_hub"),
  /**
   * Backpressure mode for the per-recipient stream append on the publish hot
   * path. Trade-off:
   *
   * - `await` (default): publish blocks until every recipient append resolves
   *   (or rejects). Preserves at-least-once delivery semantics. Slow Redis
   *   adds latency to every publish.
   * - `timeout`: each append races against `AGENT_EVENT_STREAM_APPEND_TIMEOUT_MS`.
   *   Late appends still resolve in the background but the publish path stops
   *   waiting after the timeout. Some recipients may miss the durable backlog
   *   on slow appends.
   * - `fire_and_forget`: publish never waits for appends. Lowest latency,
   *   weakest delivery guarantee — appends that fail go unnoticed by the
   *   publish caller (logged + metric only).
   */
  AGENT_EVENT_STREAM_APPEND_MODE: z.enum(["await", "timeout", "fire_and_forget"]).default("await"),
  /** Per-append timeout for `AGENT_EVENT_STREAM_APPEND_MODE=timeout`. */
  AGENT_EVENT_STREAM_APPEND_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(50),
  /**
   * When > 0, successful `bindOwnershipOnRegister(userId, agentId)` skip repeated DB work until TTL.
   * Cleared with `AgentAccessService.invalidateAccessCache*` / `invalidateAccessCacheForAgent` (same hooks as `AGENT_ACCESS_CACHE_*`).
   * `0` disables (always hit DB on each `agent:register`).
   */
  AGENT_REGISTER_BIND_CACHE_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(5_000),
  /** Max entries for the bind-register cache; `0` means unlimited (TTL still applies per entry). */
  AGENT_REGISTER_BIND_CACHE_MAX_SIZE: z.coerce.number().int().min(0).default(2_000),
  SOCKET_AUTH_REQUIRED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Disconnect registered `/agents` sockets whose registry `lastSeenAtMs` exceeds this idle threshold.
   * `0` disables idle enforcement.
   */
  SOCKET_AGENT_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),
  /** Background sweep cadence for {@link SOCKET_AGENT_IDLE_TIMEOUT_MS}. `0` disables the scheduler. */
  SOCKET_AGENT_IDLE_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(60_000),
  /**
   * Disconnect connected `/consumers` sockets whose registry `lastSeenAtMs` exceeds this idle threshold.
   * `0` disables idle enforcement.
   */
  SOCKET_CONSUMER_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(1_800_000),
  /** Background sweep cadence for {@link SOCKET_CONSUMER_IDLE_TIMEOUT_MS}. `0` disables the scheduler. */
  SOCKET_CONSUMER_IDLE_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(60_000),
  /**
   * When > 0, successful `/agents` and `/consumers` handshake DB checks may be skipped for the same
   * JWT `sub` + `credentials_version` + principal type until the TTL expires (reduces DB load on reconnect storms).
   * Block/unblock can be delayed by up to this window; use `0` (default) to always hit the DB.
   */
  SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  /**
   * When > 0, successful consumer agent-access guards may skip `assertPrincipalAccess` (and
   * redundant client-agent room joins) on the same socket+agent until the TTL expires.
   * Revokes/grants can be delayed by up to this window; use `0` (default) to always re-check.
   */
  SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(0),
  /**
   * Hard cap on async operations a single consumer socket may have in flight at once
   * across all event handlers (`agents:command`, `relay:rpc.request`, `agents:stream_pull`,
   * `relay:rpc.stream.pull`). Excess events are rejected immediately with `RATE_LIMITED`
   * so a misbehaving client cannot accumulate unbounded async work in the bridge.
   * Set `0` to disable the gate (legacy behaviour: unbounded inflight per socket).
   */
  SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET: z.coerce.number().int().min(0).max(10_000).default(32),
  /**
   * Dedicated async cap for `socket:event.publish` only. When `0` (default), publish shares
   * {@link SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET} with relay/command handlers. When > 0, publish
   * uses this counter only so relay traffic cannot starve custom publishes (and vice versa for the shared cap).
   */
  SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0),
  /** Max custom `client:custom.*` subscriptions retained per consumer socket. `0` = unlimited. */
  SOCKET_CUSTOM_EVENT_MAX_SUBSCRIPTIONS_PER_SOCKET: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(128),
  SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(60_000),
  /** Max valid subscribe/unsubscribe controls per consumer socket per window. `0` disables. */
  SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(240),
  SOCKET_AGENT_ROLES: z
    .string()
    .default("agent")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SOCKET_CONSUMER_ROLES: z
    .string()
    .default("user,admin,client")
    .transform(parseSocketConsumerRolesValue),
  /**
   * Toggle for the `client:agent.profile.updated` push that notifies approved
   * clients on the `/consumers` namespace whenever the agent catalog profile
   * changes (HTTP, socket, or pull-sync paths). Default `true` matches the
   * previously always-on behavior; set `false` as an operational kill-switch
   * without disabling the rest of the consumer namespace.
   */
  SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** TTL for the approved active client recipient cache used by client profile pushes. */
  SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(1_000),
  /** Max agent entries retained in the client profile push recipient cache. */
  SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(5_000),
  /**
   * Periodic reconciliation of `consumer:client-agent:*` rooms for connected client sockets.
   * `0` disables the sweep. Useful to converge room membership after distributed approvals.
   */
  SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(30_000),
  /** Max concurrent `listApprovedAgentIds` reads / room updates per reconcile tick. */
  SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(8),
  /** Max distinct client IDs processed per reconcile tick. Remaining clients roll to the next tick. */
  SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(200),
  /** Random delay before the first reconcile tick to avoid synchronized multi-replica sweeps. */
  SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(1_000),
  /**
   * TTL (ms) for caching `listApprovedAgentIds(clientId)` across reconcile
   * ticks and consumer bootstrap. The reconcile is a safety net (live
   * grant/revoke already push room updates), so reusing approved-agent sets
   * for a short window cuts repeated DB reads for the same client. Trades a
   * bounded convergence delay for fewer queries. `0` (default) disables the
   * cache — every tick/bootstrap fetches fresh (current behavior).
   */
  SOCKET_CONSUMER_RECONCILE_APPROVED_AGENTS_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(0),
  SOCKET_RELAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SOCKET_RELAY_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SOCKET_RELAY_STREAM_MAX_LIFETIME_MS: z.coerce.number().int().positive().default(300_000),
  SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  SOCKET_RELAY_CONVERSATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SOCKET_RELAY_MAX_CONVERSATIONS: z.coerce.number().int().positive().default(5_000),
  SOCKET_RELAY_MAX_CONVERSATIONS_PER_CONSUMER: z.coerce.number().int().positive().default(20),
  SOCKET_RELAY_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(10_000),
  SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONVERSATION: z.coerce
    .number()
    .int()
    .positive()
    .default(32),
  SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONSUMER: z.coerce.number().int().positive().default(128),
  SOCKET_RELAY_MAX_ACTIVE_STREAMS: z.coerce.number().int().positive().default(5_000),
  SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST: z.coerce.number().int().positive().default(256),
  SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS: z.coerce.number().int().positive().default(25_600),
  SOCKET_RELAY_MAX_BUFFERED_BYTES_PER_REQUEST: z.coerce
    .number()
    .int()
    .positive()
    .default(16 * 1024 * 1024),
  SOCKET_RELAY_MAX_TOTAL_BUFFERED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
  SOCKET_RELAY_IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(300_000),
  /** Background prune of relay idempotency maps; larger interval = less CPU, slower reclamation of empty maps. */
  SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  /**
   * Per-conversation cap on relay idempotency entries (one entry per
   * `client_request_id`). When exceeded, the oldest entry is evicted (FIFO) so a
   * single noisy conversation cannot exhaust memory between cleanup ticks.
   */
  SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION: z.coerce
    .number()
    .int()
    .positive()
    .max(100_000)
    .default(1_024),
  /**
   * Global cap (across all conversations) on relay idempotency entries. `0`
   * disables the global cap. When exceeded, the oldest entry across the entire
   * store is evicted (FIFO).
   */
  SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(100_000),
  SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  SOCKET_RELAY_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  SOCKET_RELAY_METRICS_LOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Probabilistic sample rate (0–1) for high-frequency relay/stream hub counters only.
   * `1` = always count; `0.1` ≈ 10% of events (scaled for unbiased totals).
   */
  SOCKET_METRICS_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  /** How long an unresolved per-request outbound tail may stay untouched before being swept as orphaned. */
  SOCKET_RELAY_OUTBOUND_TAIL_STALE_MS: z.coerce.number().int().positive().default(300_000),
  /** Background sweep cadence for stale outbound tails. */
  SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** `0` disables overload shedding by backlog size. */
  SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG: z.coerce.number().int().min(0).default(200),
  /** `0` disables overload shedding by outbound queue p95 duration. */
  SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS: z.coerce.number().int().min(0).default(250),
  SOCKET_RELAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Per consumer identity per {@link SOCKET_RELAY_RATE_LIMIT_WINDOW_MS}. `0` disables this limiter
   * (conversation starts are always allowed; counters are not incremented for enforcement).
   */
  SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(8),
  /**
   * Per consumer identity per window. `0` disables (relay RPC requests are always allowed).
   */
  SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(0).max(10_000_000).default(64),
  /**
   * Credits granted per window for `relay:rpc.stream.pull`. `0` disables (pulls are not credit-limited).
   */
  SOCKET_RELAY_RATE_LIMIT_MAX_STREAM_PULL_CREDITS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(1000),
  SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER: z.coerce.number().positive().default(3),
  /**
   * Max concurrent relay RPC dispatches per agent id. `0` = unlimited.
   * Protects one connected agent from bursts across many consumer sockets.
   */
  SOCKET_RELAY_AGENT_MAX_INFLIGHT: z.coerce.number().int().min(0).max(10_000).default(32),
  /** Max queued relay RPC dispatch waiters per agent when inflight is saturated. `0` = unlimited. */
  SOCKET_RELAY_AGENT_MAX_QUEUE: z.coerce.number().int().min(0).max(1_000_000).default(64),
  /** Max time a relay RPC request waits for an agent dispatch slot before failing with retryAfterMs. */
  SOCKET_RELAY_AGENT_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(200),
  /**
   * Feature flag for the relay batch protocol (`relay:rpc.request.batch`). When
   * `false` (default), the event is rejected with `RELAY_BATCH_DISABLED`. See
   * `docs/adrs/0008-relay-batch-protocol.md` and the implementation in
   * `src/presentation/socket/consumers/relay_rpc_request_batch.handler.ts`.
   */
  SOCKET_RELAY_BATCH_ENABLED: z.coerce.boolean().default(false),
  /**
   * When `true`, the hub ignores `fastPath: true` on inbound
   * `relay:rpc.request` envelopes and always emits `relay:rpc.accepted` for
   * the response. Use in deployments where the legacy 3-event flow is
   * mandatory (audit / compliance requirements that depend on the explicit
   * server ack). Default `false` (fast-path honored when consumer opts in).
   *
   * Does NOT affect non-fast-path traffic. See
   * `docs/socket_relay_protocol.md` ("Relay unary fast-path") and
   * `docs/plug_agente/01_relay_body_id_echo.md` for context.
   */
  SOCKET_RELAY_FAST_PATH_FORBIDDEN: z.coerce.boolean().default(false),
  /**
   * Maximum number of JSON-RPC items in a single `relay:rpc.request.batch`
   * envelope. Mirrors the REST/`agents:command` cap (`HUB_MAX_BATCH_SIZE`).
   */
  SOCKET_RELAY_BATCH_MAX_ITEMS: z.coerce.number().int().min(1).max(32).default(32),
  /**
   * Credits granted per window for legacy `/consumers` `agents:stream_pull`.
   * `0` disables the credit limiter and preserves pre-credit-limit behavior.
   */
  SOCKET_AGENTS_STREAM_PULL_RATE_LIMIT_MAX_CREDITS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(0),
  /**
   * Transitional handshake compatibility mode for `connection:ready`.
   * `payload_frame` is the default/current contract; `raw_json` exists only as a short-lived migration shim.
   */
  SOCKET_CONNECTION_READY_COMPAT_MODE: z
    .enum(["payload_frame", "raw_json"])
    .default("payload_frame"),
  /**
   * Transitional wire compatibility mode for the `/consumers` `agents:command` family
   * (`agents:command_response`, `agents:command_stream_*`). Inbound `agents:command` always
   * accepts both plain JSON and `PayloadFrame` during the migration window.
   * `payload_frame` is the default/current contract; `raw_json` exists only as a short-lived shim.
   */
  SOCKET_AGENTS_COMMAND_COMPAT_MODE: z.enum(["payload_frame", "raw_json"]).default("payload_frame"),
  /**
   * Transitional wire compatibility mode for the `/consumers` `agents:stream_pull` family
   * (`agents:stream_pull_response`). Inbound `agents:stream_pull` always accepts both plain JSON
   * and `PayloadFrame` during the migration window. Independent from
   * `SOCKET_AGENTS_COMMAND_COMPAT_MODE` so command and stream_pull can migrate on different schedules.
   * `payload_frame` is the default/current contract; `raw_json` exists only as a short-lived shim.
   */
  SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE: z
    .enum(["payload_frame", "raw_json"])
    .default("payload_frame"),
  SOCKET_REST_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(10_000),
  /**
   * Max concurrent REST→agent RPC dispatches per agent id. `0` = unlimited (no wait queue enforcement).
   */
  SOCKET_REST_AGENT_MAX_INFLIGHT: z.coerce.number().int().min(0).max(10_000).default(32),
  /**
   * Max waiters when inflight is saturated. `0` = unlimited queue depth (still subject to wait timeout).
   */
  SOCKET_REST_AGENT_MAX_QUEUE: z.coerce.number().int().min(0).max(1_000_000).default(64),
  SOCKET_REST_AGENT_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(200),
  /** Window size for automatic `rpc:stream.pull` when the REST bridge materializes a streaming `sql.execute` result. */
  SOCKET_REST_STREAM_PULL_WINDOW_SIZE: z.coerce.number().int().positive().max(10_000).default(256),
  /** Upper bound advertised to agents for hub-initiated stream pull windows. */
  SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(256),
  /**
   * Max aggregated rows allowed when REST materializes a streaming `sql.execute` (`stream_id` + chunks).
   * `0` disables the limit (not recommended for large deployments).
   */
  SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(1_000_000),
  /**
   * Max `rpc:chunk` frames accepted during REST materialization. `0` = unlimited
   * (legacy behaviour, only safe when `MAX_ROWS > 0` and agents are trusted).
   * Default `100_000` provides a hard ceiling against runaway streams.
   */
  SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(100_000),
  /**
   * Hard cap on aggregated UTF-8 bytes materialized for a single REST SQL stream.
   * Inbound PayloadFrame metadata supplies the hot-path byte count; legacy fallback
   * still estimates via JSON serialization. Complements `MAX_ROWS` for large rows
   * (JSONB blobs). `0` disables the byte cap. Default 256 MiB matches Node default
   * `--max-old-space-size` headroom.
   */
  SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024 * 1024)
    .default(256 * 1024 * 1024),
  /**
   * Max Engine.IO packet size (bytes). Must fit PayloadFrame compressed ceiling (10 MB).
   * Default 10 MiB matches `payload_frame` limits.
   */
  SOCKET_IO_MAX_HTTP_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  /**
   * When false, disables WebSocket permessage-deflate (PayloadFrame already handles gzip at app layer).
   */
  SOCKET_IO_PER_MESSAGE_DEFLATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Comma-separated: `websocket`, `polling`. If unset: `websocket` only when NODE_ENV=production (less handshake/CPU).
   */
  SOCKET_IO_TRANSPORTS: z.preprocess(
    (val) => {
      if (val !== undefined && val !== "" && String(val).trim() !== "") {
        return String(val).trim();
      }
      return isProductionNodeEnv() ? "websocket" : "websocket,polling";
    },
    z
      .string()
      .transform((v) => {
        const parts = v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        return [...new Set(parts)];
      })
      .superRefine((arr, ctx) => {
        const allowed = new Set(["websocket", "polling"]);
        for (const t of arr) {
          if (!allowed.has(t)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Invalid SOCKET_IO_TRANSPORTS entry "${t}" (allowed: websocket, polling)`,
            });
          }
        }
        if (arr.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "SOCKET_IO_TRANSPORTS must list at least one transport",
          });
        }
      }),
  ),
  /** Hub API: do not serve socket.io client assets from this server (less HTTP surface, default off). */
  SOCKET_IO_SERVE_CLIENT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Optional Redis adapter for Socket.IO rooms/pubsub across hub replicas.
   * Empty keeps the default in-memory adapter.
   */
  SOCKET_IO_REDIS_ADAPTER_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * When true, initial Redis adapter connect failure aborts bootstrap whenever
   * `SOCKET_IO_REDIS_ADAPTER_URL` is set (even outside production).
   */
  SOCKET_IO_REDIS_ADAPTER_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Engine.IO compression for long-polling responses. If unset: `false` when NODE_ENV=production (saves CPU with websocket-only default).
   */
  SOCKET_IO_HTTP_COMPRESSION: z.preprocess(
    (val) => {
      if (val !== undefined && val !== "" && String(val).trim() !== "") {
        return String(val).trim().toLowerCase();
      }
      return isProductionNodeEnv() ? "false" : "true";
    },
    z.enum(["true", "false"]).transform((v) => v === "true"),
  ),
  /** Override Engine.IO ping interval (ms). Omit for default 25000. */
  SOCKET_IO_PING_INTERVAL_MS: z.preprocess(
    (val) => (val === undefined || val === "" ? undefined : val),
    z.coerce.number().int().positive().max(120_000).optional(),
  ),
  /** Override Engine.IO ping timeout (ms). Omit for default 20000. */
  SOCKET_IO_PING_TIMEOUT_MS: z.preprocess(
    (val) => (val === undefined || val === "" ? undefined : val),
    z.coerce.number().int().positive().max(120_000).optional(),
  ),
  /** Override Engine.IO transport upgrade timeout (ms). Omit for default 10000. */
  SOCKET_IO_UPGRADE_TIMEOUT_MS: z.preprocess(
    (val) => (val === undefined || val === "" ? undefined : val),
    z.coerce.number().int().positive().max(120_000).optional(),
  ),
  /**
   * Redis pub/sub channel prefix for `@socket.io/redis-adapter`.
   * Use a distinct key when sharing a Redis instance with other Socket.IO clusters.
   */
  SOCKET_IO_REDIS_ADAPTER_KEY: z.preprocess(
    (val) => (val === undefined || val === "" ? "socket.io" : String(val).trim()),
    z.string().min(1).max(256),
  ),
  /**
   * Timeout (ms) for cross-node adapter requests (`fetchSockets`, `allRooms`, etc.).
   * Matches `@socket.io/redis-adapter` library default (5000).
   */
  SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(5_000),
  /**
   * When true, adapter responses publish to a node-specific Redis channel.
   * Matches library default (`false`); may become default `true` in a future major release.
   */
  SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** `node-redis` socket connect timeout (ms). Library default 5000. */
  SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(5_000),
  /** Base delay (ms) for hub reconnect backoff after Redis adapter runtime failure. */
  SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(1_000),
  /** Max delay (ms) for hub reconnect backoff after Redis adapter runtime failure. */
  SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(30_000),
  /**
   * Optional Redis for distributed agent presence and inter-replica bridge
   * forward. When empty, falls back to `SOCKET_IO_REDIS_ADAPTER_URL`.
   */
  AGENT_HUB_PRESENCE_REDIS_URL: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * When false, presence and bridge forward stay disabled even if a Redis URL
   * resolves. Default true.
   */
  AGENT_HUB_PRESENCE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** TTL (ms) for presence keys; renewed on register and touch. */
  AGENT_HUB_PRESENCE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(120_000),
  /** Max wait (ms) for a bridge forward reply from the owning replica. */
  AGENT_HUB_BRIDGE_FORWARD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(15_000),
  /**
   * Comma-separated hub instance ids in this cluster (e.g. plug-4000,plug-4001).
   * Used for peer bridge forward when Redis presence is missing or stale.
   */
  AGENT_HUB_CLUSTER_INSTANCE_IDS: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  SOCKET_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  SOCKET_AUDIT_PRUNE_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),
  /** Max events per DB transaction when > 1; 1 disables batching (legacy single INSERT). */
  SOCKET_AUDIT_BATCH_MAX: z.coerce.number().int().positive().max(500).default(48),
  SOCKET_AUDIT_BATCH_FLUSH_MS: z.coerce.number().int().positive().max(30_000).default(200),
  /**
   * Max in-memory queued audit events before new events are dropped (oldest-wins).
   * `0` disables the cap (legacy unlimited behaviour, OOM risk under DB stalls).
   */
  SOCKET_AUDIT_MAX_QUEUE: z.coerce.number().int().min(0).max(10_000_000).default(50_000),
  /**
   * Percentage (0–100) of `relay:rpc.chunk` audit events persisted. If unset: 25 in production, 100 otherwise.
   */
  SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT: z.preprocess((val) => {
    if (val !== undefined && val !== "" && String(val).trim() !== "") {
      return val;
    }
    return isProductionNodeEnv() ? "25" : "100";
  }, z.coerce.number().int().min(0).max(100)),
  SWAGGER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max requests per window per authenticated user (JWT `sub`). `0` = unlimited (HTTP + socket consumer). */
  REST_AGENTS_COMMANDS_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(100),
  /**
   * Sliding window (ms) for `PATCH /agents/:agentId/profile` per authenticated agent.
   * Independent from {@link REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS} so profile updates
   * can be tuned separately from command invocations.
   */
  REST_AGENTS_SELF_PROFILE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max profile patch requests per window per agent. `0` = unlimited. */
  REST_AGENTS_SELF_PROFILE_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(20),
  /**
   * When true, Socket `agents:command` consumes rate-limit budget according to
   * command workload (batch item count / sql.executeBatch command count).
   * Default false preserves the historical one-event = one-credit behaviour.
   */
  SOCKET_AGENTS_COMMAND_RATE_LIMIT_WEIGHTED_COSTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Optional second limiter on `POST /agents/commands` keyed by `req.ip` (same window as above).
   * `0` disables. Use behind `trust proxy` when the server is behind a reverse proxy.
   */
  REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX: z.coerce.number().int().nonnegative().default(0),
  /**
   * TTL (ms) for the in-process agent-access cache in `AgentAccessService`.
   * Caches positive `assertPrincipalAccess` results so the two DB queries
   * (agent snapshot + identity/client access row) are not repeated on every
   * bridge command within the window. `0` disables.
   */
  AGENT_ACCESS_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
  /** Max entries in the agent-access cache (oldest evicted first). `0` = unlimited. */
  AGENT_ACCESS_CACHE_MAX_SIZE: z.coerce.number().int().min(0).default(5_000),
  /**
   * TTL (ms) for the in-process principal active-snapshot cache in `AuthService`
   * and `ClientAuthService`. Caches `getActiveAccountUserSnapshot` /
   * `getActiveClientSnapshot` results per `sub:credentials_version` so repeated
   * DB status checks are skipped within the window. `0` disables.
   *
   * Security note: a blocked account continues to pass the snapshot check until
   * the entry expires. Socket connections are disconnected immediately by
   * `adminSetUserStatus`; HTTP commands are bounded by this TTL (default 15 s).
   */
  PRINCIPAL_SNAPSHOT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(15_000),
  /** Max entries in the principal snapshot cache. `0` = unlimited. */
  PRINCIPAL_SNAPSHOT_CACHE_MAX_SIZE: z.coerce.number().int().min(0).default(2_000),
  /** Window for `PATCH /admin/users/:id/status` per admin (`JWT sub`). */
  REST_ADMIN_USER_STATUS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max status changes per window per admin. `0` = unlimited. */
  REST_ADMIN_USER_STATUS_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(60),
  BRIDGE_LOG_JSONRPC_AUTO_ID: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Persist hub↔agent bridge phase timings to PostgreSQL (REST + consumer socket). */
  BRIDGE_LATENCY_TRACE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** When enabled, percentage (0–100) of bridge commands that record a trace row. */
  BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT: z.coerce.number().int().min(0).max(100).default(100),
  BRIDGE_LATENCY_TRACE_BATCH_MAX: z.coerce.number().int().positive().max(500).default(48),
  BRIDGE_LATENCY_TRACE_BATCH_FLUSH_MS: z.coerce.number().int().positive().max(30_000).default(200),
  /**
   * Max queued rows in memory before dropping new rows (oldest-wins). `0` disables the cap
   * (legacy unlimited behaviour, OOM risk under DB stalls). Default 50_000 caps memory while
   * still absorbing significant DB hiccups.
   */
  BRIDGE_LATENCY_TRACE_MAX_QUEUE: z.coerce.number().int().min(0).max(10_000_000).default(50_000),
  /**
   * Always persist rows when wall `total_ms` is at least this value (0 = disabled).
   * Works with `BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT` for successful fast requests.
   */
  BRIDGE_LATENCY_TRACE_SLOW_TOTAL_MS: z.coerce.number().int().min(0).default(0),
  BRIDGE_LATENCY_TRACE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  BRIDGE_LATENCY_TRACE_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  BRIDGE_LATENCY_TRACE_PRUNE_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),
  /**
   * Interval (minutes) at which `bridge_latency_trace_hourly_rollups` is refreshed
   * via `REFRESH MATERIALIZED VIEW CONCURRENTLY`. Coordinated across replicas
   * by an advisory lock. Set `0` to disable the scheduler (refresh manually).
   */
  BRIDGE_LATENCY_TRACE_ROLLUP_REFRESH_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(1440)
    .default(10),
  /** When true, emit an OpenTelemetry span per bridge trace (requires tracer configured globally). */
  BRIDGE_LATENCY_TRACE_OTEL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * If |total_ms - phases_sum_ms| exceeds this, increment metric and log at debug (0 = off).
   */
  BRIDGE_LATENCY_TRACE_PHASES_MISMATCH_WARN_MS: z.coerce.number().int().min(0).default(0),
  /** When true, `user_id` is not stored in `bridge_latency_traces`. */
  BRIDGE_LATENCY_TRACE_REDACT_USER_ID: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Max UTF-8 characters of `request_id` to persist (0 = full string). */
  BRIDGE_LATENCY_TRACE_TRUNCATE_REQUEST_ID_CHARS: z.coerce
    .number()
    .int()
    .min(0)
    .max(128)
    .default(0),
  /**
   * Retention for `channel = relay` only. If unset/empty, uses `BRIDGE_LATENCY_TRACE_RETENTION_DAYS`.
   */
  BRIDGE_LATENCY_TRACE_RELAY_RETENTION_DAYS: z.preprocess(
    (val) => (val === undefined || val === "" ? undefined : val),
    z.coerce.number().int().positive().optional(),
  ),
  AGENT_PROFILE_REVISION_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  AGENT_PROFILE_IDEMPOTENCY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  AGENT_PROFILE_MAINTENANCE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  AGENT_PROFILE_MAINTENANCE_PRUNE_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),
  CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(1_000),
});

const parsedEnv = envSchema.parse(process.env);
const insecureSecrets = new Set(["change-me-access-development", "change-me-refresh-development"]);

if (parsedEnv.NODE_ENV === "production") {
  if (parsedEnv.CORS_ORIGIN === "*") {
    throw new Error("Invalid production config: CORS_ORIGIN cannot be '*'.");
  }

  if (
    insecureSecrets.has(parsedEnv.JWT_ACCESS_SECRET) ||
    insecureSecrets.has(parsedEnv.JWT_REFRESH_SECRET)
  ) {
    throw new Error("Invalid production config: JWT secrets must be explicitly configured.");
  }

  if (parsedEnv.REQUIRE_SMTP_IN_PRODUCTION) {
    const smtpConfigured = parsedEnv.SMTP_USER.trim() !== "" && parsedEnv.SMTP_PASS.trim() !== "";
    if (!smtpConfigured) {
      throw new Error(
        "Invalid production config: SMTP_USER and SMTP_PASS are required when REQUIRE_SMTP_IN_PRODUCTION=true.",
      );
    }
  }

  if (!parsedEnv.SOCKET_AUTH_REQUIRED) {
    throw new Error("Invalid production config: SOCKET_AUTH_REQUIRED must be true in production.");
  }

  if (parsedEnv.STRICT_REDIS_AUTH) {
    const agentHubPresenceRedisUrlForAuth =
      parsedEnv.AGENT_HUB_PRESENCE_REDIS_URL.trim() ||
      parsedEnv.SOCKET_IO_REDIS_ADAPTER_URL.trim();
    const redisUrlsByName: ReadonlyArray<readonly [string, string]> = [
      ["SOCKET_IO_REDIS_ADAPTER_URL", parsedEnv.SOCKET_IO_REDIS_ADAPTER_URL],
      ["REST_RATE_LIMIT_REDIS_URL", parsedEnv.REST_RATE_LIMIT_REDIS_URL],
      ["SOCKET_RATE_LIMIT_REDIS_URL", parsedEnv.SOCKET_RATE_LIMIT_REDIS_URL],
      [
        "REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL",
        parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL,
      ],
      ["AGENT_HUB_PRESENCE_REDIS_URL", agentHubPresenceRedisUrlForAuth],
    ];
    for (const [name, raw] of redisUrlsByName) {
      const url = raw.trim();
      if (url === "") {
        continue;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error(`Invalid production config: ${name} is not a valid URL.`);
      }
      if (parsedUrl.protocol === "redis:" && !parsedUrl.password) {
        throw new Error(
          `Invalid production config: ${name} must use rediss:// (TLS) or include a password when STRICT_REDIS_AUTH=true.`,
        );
      }
    }
  }

  if (parsedEnv.SOCKET_CONNECTION_READY_COMPAT_MODE === "raw_json") {
    throw new Error(
      "Invalid production config: SOCKET_CONNECTION_READY_COMPAT_MODE must not be raw_json in production.",
    );
  }

  if (parsedEnv.SOCKET_AGENTS_COMMAND_COMPAT_MODE === "raw_json") {
    throw new Error(
      "Invalid production config: SOCKET_AGENTS_COMMAND_COMPAT_MODE must not be raw_json in production.",
    );
  }

  if (parsedEnv.SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE === "raw_json") {
    throw new Error(
      "Invalid production config: SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE must not be raw_json in production.",
    );
  }

  const agentHubPresenceRedisUrlResolved =
    parsedEnv.AGENT_HUB_PRESENCE_REDIS_URL.trim() ||
    parsedEnv.SOCKET_IO_REDIS_ADAPTER_URL.trim();
  const agentHubPresenceEnabled =
    parsedEnv.AGENT_HUB_PRESENCE_ENABLED && agentHubPresenceRedisUrlResolved !== "";
  if (
    agentHubPresenceEnabled &&
    parsedEnv.AGENT_HUB_PRESENCE_REDIS_URL.trim() !== "" &&
    parsedEnv.HUB_INSTANCE_ID.trim() === ""
  ) {
    throw new Error(
      "Invalid production config: HUB_INSTANCE_ID is required when AGENT_HUB_PRESENCE_REDIS_URL is set.",
    );
  }
}

const agentHubPresenceRedisUrlResolved =
  parsedEnv.AGENT_HUB_PRESENCE_REDIS_URL.trim() || parsedEnv.SOCKET_IO_REDIS_ADAPTER_URL.trim();
const agentHubPresenceEnabled =
  parsedEnv.AGENT_HUB_PRESENCE_ENABLED && agentHubPresenceRedisUrlResolved !== "";

export const env = {
  appName: parsedEnv.APP_NAME,
  rootLandingLang: parsedEnv.ROOT_LANDING_LANG as RootLandingLangConfig,
  hubInstanceId: parsedEnv.HUB_INSTANCE_ID,
  nodeEnv: parsedEnv.NODE_ENV,
  persistenceMode:
    parsedEnv.CONTAINER_PERSISTENCE_MODE === "auto"
      ? parsedEnv.NODE_ENV === "test"
        ? "memory"
        : "prisma"
      : parsedEnv.CONTAINER_PERSISTENCE_MODE,
  emailSenderMode:
    parsedEnv.CONTAINER_EMAIL_SENDER_MODE === "auto"
      ? parsedEnv.NODE_ENV === "test"
        ? "noop"
        : "smtp"
      : parsedEnv.CONTAINER_EMAIL_SENDER_MODE,
  httpTrustProxy: parsedEnv.HTTP_TRUST_PROXY,
  port: parsedEnv.PORT,
  corsOrigin: parsedEnv.CORS_ORIGIN,
  corsOrigins:
    parsedEnv.CORS_ORIGIN === "*"
      ? ("*" as const)
      : parsedEnv.CORS_ORIGIN.split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
  requestBodyLimit: parsedEnv.REQUEST_BODY_LIMIT,
  httpRequestTimeoutMs: parsedEnv.HTTP_REQUEST_TIMEOUT_MS,
  uploadsDir: parsedEnv.UPLOADS_DIR,
  uploadsPublicBaseUrl: parsedEnv.UPLOADS_PUBLIC_BASE_URL.replace(/\/+$/, ""),
  clientThumbnailMaxBytes: parsedEnv.CLIENT_THUMBNAIL_MAX_BYTES,
  clientThumbnailWidth: parsedEnv.CLIENT_THUMBNAIL_WIDTH,
  clientThumbnailHeight: parsedEnv.CLIENT_THUMBNAIL_HEIGHT,
  clientThumbnailWebpQuality: parsedEnv.CLIENT_THUMBNAIL_WEBP_QUALITY,
  restClientThumbnailRateLimitWindowMs: parsedEnv.REST_CLIENT_THUMBNAIL_RATE_LIMIT_WINDOW_MS,
  restClientThumbnailRateLimitMax: parsedEnv.REST_CLIENT_THUMBNAIL_RATE_LIMIT_MAX,
  restGlobalRateLimitWindowMs: parsedEnv.REST_GLOBAL_RATE_LIMIT_WINDOW_MS,
  restGlobalRateLimitMax: parsedEnv.REST_GLOBAL_RATE_LIMIT_MAX,
  restCredentialAuthRateLimitWindowMs: parsedEnv.REST_CREDENTIAL_AUTH_RATE_LIMIT_WINDOW_MS,
  restCredentialAuthRateLimitMax: parsedEnv.REST_CREDENTIAL_AUTH_RATE_LIMIT_MAX,
  restTokenRefreshRateLimitWindowMs: parsedEnv.REST_TOKEN_REFRESH_RATE_LIMIT_WINDOW_MS,
  restTokenRefreshRateLimitMax: parsedEnv.REST_TOKEN_REFRESH_RATE_LIMIT_MAX,
  restRateLimitRedisUrl: parsedEnv.REST_RATE_LIMIT_REDIS_URL,
  restClientMeAgentsPostRateLimitWindowMs:
    parsedEnv.REST_CLIENT_ME_AGENTS_POST_RATE_LIMIT_WINDOW_MS,
  restClientMeAgentsPostRateLimitMax: parsedEnv.REST_CLIENT_ME_AGENTS_POST_RATE_LIMIT_MAX,
  restSocketEventRateLimitWindowMs: parsedEnv.REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS,
  restSocketEventRateLimitMax: parsedEnv.REST_SOCKET_EVENT_RATE_LIMIT_MAX,
  restSocketEventMaxFiles: parsedEnv.REST_SOCKET_EVENT_MAX_FILES,
  restSocketEventFileMaxBytes: parsedEnv.REST_SOCKET_EVENT_FILE_MAX_BYTES,
  restSocketEventTotalFilesMaxBytes: parsedEnv.REST_SOCKET_EVENT_TOTAL_FILES_MAX_BYTES,
  restSocketEventPayloadJsonMaxBytes: parsedEnv.REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES,
  restSocketEventMaxRecipients: parsedEnv.REST_SOCKET_EVENT_MAX_RECIPIENTS,
  restSocketEventBestEffortLocalMaxRecipients:
    parsedEnv.REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS,
  restSocketEventDistributedCountFailureThreshold:
    parsedEnv.REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_THRESHOLD,
  restSocketEventDistributedCountFailureOpenMs:
    parsedEnv.REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_OPEN_MS,
  restSocketEventFanoutRetryAfterMs: parsedEnv.REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS,
  restSocketEventIdempotencyTtlMs: parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS,
  restSocketEventIdempotencyMaxEntries: parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES,
  restSocketEventIdempotencySerializationMaxKeys:
    parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS,
  restSocketEventIdempotencyRedisUrl: parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL,
  restSocketEventIdempotencyRedisLockTtlMs:
    parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_TTL_MS,
  restSocketEventIdempotencyRedisWaitMs: parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_WAIT_MS,
  restSocketEventIdempotencyRedisLockRenewalMs:
    parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_RENEWAL_MS,
  restSocketEventIdempotencyRedisReadUrl: parsedEnv.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_READ_URL,
  socketCustomEventPublishRateLimitWindowMs:
    parsedEnv.SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_WINDOW_MS ??
    parsedEnv.REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS,
  socketCustomEventPublishRateLimitMax:
    parsedEnv.SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_MAX ??
    parsedEnv.REST_SOCKET_EVENT_RATE_LIMIT_MAX,
  restSocketEventHttpJsonBodyLimit:
    parsedEnv.REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT.trim() !== ""
      ? parsedEnv.REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT.trim()
      : defaultRestSocketEventHttpJsonBodyLimit(
          parsedEnv.REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES,
          parsedEnv.REST_SOCKET_EVENT_TOTAL_FILES_MAX_BYTES,
        ),
  /**
   * Max UTF-8 bytes of `JSON.stringify(socket:event.publish)` envelope before Zod (defence in depth).
   * Derived from REST limits and capped by {@link SOCKET_IO_MAX_HTTP_BUFFER_BYTES} (Engine.IO packet size).
   */
  socketEventPublishRawJsonMaxBytes: socketEventPublishRawJsonUpperBound(
    parsedEnv.REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES,
    parsedEnv.REST_SOCKET_EVENT_TOTAL_FILES_MAX_BYTES,
    parsedEnv.SOCKET_IO_MAX_HTTP_BUFFER_BYTES,
  ),
  clientAgentAccessRequestEmailDebounceMs: parsedEnv.CLIENT_AGENT_ACCESS_REQUEST_EMAIL_DEBOUNCE_MS,
  clientAgentAccessMaxRetries: parsedEnv.CLIENT_AGENT_ACCESS_MAX_RETRIES,
  restClientPasswordRecoveryRateLimitWindowMs:
    parsedEnv.REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_WINDOW_MS,
  restClientPasswordRecoveryRateLimitMax: parsedEnv.REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX,
  databaseUrl: parsedEnv.DATABASE_URL,
  databaseTransactionRetryMaxAttempts: parsedEnv.DATABASE_TRANSACTION_RETRY_MAX_ATTEMPTS,
  databaseTransactionRetryBaseDelayMs: parsedEnv.DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS,
  jwtAccessSecret: parsedEnv.JWT_ACCESS_SECRET,
  jwtAccessExpiresIn: parsedEnv.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshSecret: parsedEnv.JWT_REFRESH_SECRET,
  jwtRefreshExpiresIn: parsedEnv.JWT_REFRESH_EXPIRES_IN,
  jwtVerifyCacheTtlMs: parsedEnv.JWT_VERIFY_CACHE_TTL_MS,
  metricsResponseCacheTtlMs: parsedEnv.METRICS_RESPONSE_CACHE_TTL_MS,
  jwtVerifyCacheMaxSize: parsedEnv.JWT_VERIFY_CACHE_MAX_SIZE,
  otelTracesEnabled: parsedEnv.OTEL_TRACES_ENABLED,
  redisOtelSpansEnabled: parsedEnv.REDIS_OTEL_SPANS_ENABLED,
  otelTracesSamplerArg: parsedEnv.OTEL_TRACES_SAMPLER_ARG,
  otelExporterOtlpEndpoint: parsedEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
  otelServiceName: parsedEnv.OTEL_SERVICE_NAME,
  jwtIssuer: parsedEnv.JWT_ISSUER,
  jwtAudience: parsedEnv.JWT_AUDIENCE,
  payloadSigningKey: parsedEnv.PAYLOAD_SIGNING_KEY,
  payloadSigningKeyId: parsedEnv.PAYLOAD_SIGNING_KEY_ID,
  payloadSigningPreviousKeys: parsedEnv.PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON,
  payloadSignOutbound: parsedEnv.PAYLOAD_SIGN_OUTBOUND,
  payloadFrameCompressMinBytes: parsedEnv.PAYLOAD_FRAME_COMPRESS_MIN_BYTES,
  payloadFrameMaxGzipInputBytes: parsedEnv.PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES,
  payloadFrameGzipLevel: parsedEnv.PAYLOAD_FRAME_GZIP_LEVEL,
  payloadFrameAutoGzipMinSavingsBytes: parsedEnv.PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES,
  payloadFrameAsyncGzipMinUtf8Bytes: parsedEnv.PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES,
  payloadFrameAsyncGunzipMinCompressedBytes:
    parsedEnv.PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES,
  agentSqlBulkInsertMaxRows: parsedEnv.AGENT_SQL_BULK_INSERT_MAX_ROWS,
  agentSqlBulkInsertMaxJsonBytes: parsedEnv.AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES,
  socketAgentInboundContractValidation: parsedEnv.SOCKET_AGENT_INBOUND_CONTRACT_VALIDATION,
  socketAgentAckRetryEnabled: parsedEnv.SOCKET_AGENT_ACK_RETRY_ENABLED,
  socketAgentAckTimeoutMs: parsedEnv.SOCKET_AGENT_ACK_TIMEOUT_MS,
  socketAgentAckMaxRetries: parsedEnv.SOCKET_AGENT_ACK_MAX_RETRIES,
  socketAgentKnownIdsMax: parsedEnv.SOCKET_AGENT_KNOWN_IDS_MAX,
  socketAgentProfileSyncMaxConcurrent: parsedEnv.SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT,
  socketAgentProtocolReadyGraceMs: parsedEnv.SOCKET_AGENT_PROTOCOL_READY_GRACE_MS,
  socketAgentSessionPolicy: parsedEnv.SOCKET_AGENT_SESSION_POLICY,
  socketAgentRegisterRateLimitWindowMs: parsedEnv.SOCKET_AGENT_REGISTER_RATE_LIMIT_WINDOW_MS,
  socketAgentRegisterRateLimitMax: parsedEnv.SOCKET_AGENT_REGISTER_RATE_LIMIT_MAX,
  socketRateLimitRedisUrl: parsedEnv.SOCKET_RATE_LIMIT_REDIS_URL,
  agentRegisterBindCacheTtlMs: parsedEnv.AGENT_REGISTER_BIND_CACHE_TTL_MS,
  agentRegisterBindCacheMaxSize: parsedEnv.AGENT_REGISTER_BIND_CACHE_MAX_SIZE,
  socketAuthRequired: parsedEnv.SOCKET_AUTH_REQUIRED,
  socketAgentAuthBypassAllowed:
    parsedEnv.NODE_ENV === "test" && parsedEnv.SOCKET_AUTH_REQUIRED === false,
  socketAgentIdleTimeoutMs: parsedEnv.SOCKET_AGENT_IDLE_TIMEOUT_MS,
  socketAgentIdleSweepIntervalMs: parsedEnv.SOCKET_AGENT_IDLE_SWEEP_INTERVAL_MS,
  socketConsumerIdleTimeoutMs: parsedEnv.SOCKET_CONSUMER_IDLE_TIMEOUT_MS,
  socketConsumerIdleSweepIntervalMs: parsedEnv.SOCKET_CONSUMER_IDLE_SWEEP_INTERVAL_MS,
  socketAuthAccountSnapshotTtlMs: parsedEnv.SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS,
  socketConsumerAgentAccessSnapshotTtlMs: parsedEnv.SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS,
  socketConsumerMaxInflightPerSocket: parsedEnv.SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET,
  socketCustomEventPublishMaxInflightPerSocket:
    parsedEnv.SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET,
  socketCustomEventMaxSubscriptionsPerSocket:
    parsedEnv.SOCKET_CUSTOM_EVENT_MAX_SUBSCRIPTIONS_PER_SOCKET,
  socketCustomEventSubscriptionRateLimitWindowMs:
    parsedEnv.SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_WINDOW_MS,
  socketCustomEventSubscriptionRateLimitMax:
    parsedEnv.SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_MAX,
  socketAgentRoles: parsedEnv.SOCKET_AGENT_ROLES,
  socketConsumerRoles: parsedEnv.SOCKET_CONSUMER_ROLES.roles,
  socketConsumerRolesClientAppended: parsedEnv.SOCKET_CONSUMER_ROLES.clientAppended,
  socketClientAgentProfilePushEnabled: parsedEnv.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED,
  socketClientAgentProfileRecipientCacheTtlMs:
    parsedEnv.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS,
  socketClientAgentProfileRecipientCacheMaxSize:
    parsedEnv.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE,
  socketConsumerClientAgentRoomReconcileIntervalMs:
    parsedEnv.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS,
  socketConsumerClientAgentRoomReconcileConcurrency:
    parsedEnv.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY,
  socketConsumerClientAgentRoomReconcileMaxClientsPerTick:
    parsedEnv.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK,
  socketConsumerClientAgentRoomReconcileStartJitterMs:
    parsedEnv.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS,
  socketConsumerReconcileApprovedAgentsCacheTtlMs:
    parsedEnv.SOCKET_CONSUMER_RECONCILE_APPROVED_AGENTS_CACHE_TTL_MS,
  socketRelayRequestTimeoutMs: parsedEnv.SOCKET_RELAY_REQUEST_TIMEOUT_MS,
  socketRelayStreamIdleTimeoutMs: parsedEnv.SOCKET_RELAY_STREAM_IDLE_TIMEOUT_MS,
  socketRelayStreamMaxLifetimeMs: parsedEnv.SOCKET_RELAY_STREAM_MAX_LIFETIME_MS,
  socketRelayConversationIdleTimeoutMs: parsedEnv.SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS,
  socketRelayConversationSweepIntervalMs: parsedEnv.SOCKET_RELAY_CONVERSATION_SWEEP_INTERVAL_MS,
  socketRelayMaxConversations: parsedEnv.SOCKET_RELAY_MAX_CONVERSATIONS,
  socketRelayMaxConversationsPerConsumer: parsedEnv.SOCKET_RELAY_MAX_CONVERSATIONS_PER_CONSUMER,
  socketRelayMaxPendingRequests: parsedEnv.SOCKET_RELAY_MAX_PENDING_REQUESTS,
  socketRelayMaxPendingRequestsPerConversation:
    parsedEnv.SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONVERSATION,
  socketRelayMaxPendingRequestsPerConsumer:
    parsedEnv.SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONSUMER,
  socketRelayMaxActiveStreams: parsedEnv.SOCKET_RELAY_MAX_ACTIVE_STREAMS,
  socketRelayMaxBufferedChunksPerRequest: parsedEnv.SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST,
  socketRelayMaxTotalBufferedChunks: parsedEnv.SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS,
  socketRelayMaxBufferedBytesPerRequest: parsedEnv.SOCKET_RELAY_MAX_BUFFERED_BYTES_PER_REQUEST,
  socketRelayMaxTotalBufferedBytes: parsedEnv.SOCKET_RELAY_MAX_TOTAL_BUFFERED_BYTES,
  socketRelayIdempotencyTtlMs: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_TTL_MS,
  socketRelayIdempotencyCleanupIntervalMs: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  socketRelayIdempotencyMaxEntriesPerConversation:
    parsedEnv.SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION,
  socketRelayIdempotencyMaxTotalEntries: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES,
  socketRelayCircuitFailureThreshold: parsedEnv.SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD,
  socketRelayCircuitOpenMs: parsedEnv.SOCKET_RELAY_CIRCUIT_OPEN_MS,
  socketRelayMetricsLogIntervalMs: parsedEnv.SOCKET_RELAY_METRICS_LOG_INTERVAL_MS,
  socketMetricsSampleRate: parsedEnv.SOCKET_METRICS_SAMPLE_RATE,
  socketRelayOutboundTailStaleMs: parsedEnv.SOCKET_RELAY_OUTBOUND_TAIL_STALE_MS,
  socketRelayOutboundSweepIntervalMs: parsedEnv.SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS,
  socketRelayOutboundOverloadBacklog: parsedEnv.SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG,
  socketRelayOutboundOverloadP95Ms: parsedEnv.SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS,
  socketRelayRateLimitWindowMs: parsedEnv.SOCKET_RELAY_RATE_LIMIT_WINDOW_MS,
  socketRelayRateLimitMaxConversationStarts:
    parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS,
  socketRelayRateLimitMaxRequests: parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS,
  socketRelayRateLimitMaxStreamPullCredits:
    parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_STREAM_PULL_CREDITS,
  socketRelayRateLimitSweepStaleMultiplier:
    parsedEnv.SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER,
  socketRelayAgentMaxInflight: parsedEnv.SOCKET_RELAY_AGENT_MAX_INFLIGHT,
  socketRelayAgentMaxQueue: parsedEnv.SOCKET_RELAY_AGENT_MAX_QUEUE,
  socketRelayAgentQueueWaitMs: parsedEnv.SOCKET_RELAY_AGENT_QUEUE_WAIT_MS,
  socketRelayBatchEnabled: parsedEnv.SOCKET_RELAY_BATCH_ENABLED,
  socketRelayFastPathForbidden: parsedEnv.SOCKET_RELAY_FAST_PATH_FORBIDDEN,
  socketRelayBatchMaxItems: parsedEnv.SOCKET_RELAY_BATCH_MAX_ITEMS,
  socketAgentsStreamPullRateLimitMaxCredits:
    parsedEnv.SOCKET_AGENTS_STREAM_PULL_RATE_LIMIT_MAX_CREDITS,
  socketConnectionReadyCompatMode: parsedEnv.SOCKET_CONNECTION_READY_COMPAT_MODE,
  socketAgentsCommandCompatMode: parsedEnv.SOCKET_AGENTS_COMMAND_COMPAT_MODE,
  socketAgentsStreamPullCompatMode: parsedEnv.SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE,
  socketRestMaxPendingRequests: parsedEnv.SOCKET_REST_MAX_PENDING_REQUESTS,
  socketRestAgentMaxInflight: parsedEnv.SOCKET_REST_AGENT_MAX_INFLIGHT,
  socketRestAgentMaxQueue: parsedEnv.SOCKET_REST_AGENT_MAX_QUEUE,
  socketRestAgentQueueWaitMs: parsedEnv.SOCKET_REST_AGENT_QUEUE_WAIT_MS,
  socketRestStreamPullWindowSize: parsedEnv.SOCKET_REST_STREAM_PULL_WINDOW_SIZE,
  socketRestStreamPullMaxWindowSize: parsedEnv.SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE,
  socketRestSqlStreamMaterializeMaxRows: parsedEnv.SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS,
  socketRestSqlStreamMaterializeMaxChunks: parsedEnv.SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS,
  socketRestSqlStreamMaterializeMaxBytes: parsedEnv.SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_BYTES,
  socketIoMaxHttpBufferBytes: parsedEnv.SOCKET_IO_MAX_HTTP_BUFFER_BYTES,
  socketIoPerMessageDeflate: parsedEnv.SOCKET_IO_PER_MESSAGE_DEFLATE,
  socketIoTransports: parsedEnv.SOCKET_IO_TRANSPORTS as ("websocket" | "polling")[],
  socketIoServeClient: parsedEnv.SOCKET_IO_SERVE_CLIENT,
  socketIoRedisAdapterUrl: parsedEnv.SOCKET_IO_REDIS_ADAPTER_URL,
  socketIoRedisAdapterRequired: parsedEnv.SOCKET_IO_REDIS_ADAPTER_REQUIRED,
  socketIoHttpCompression: parsedEnv.SOCKET_IO_HTTP_COMPRESSION,
  socketIoPingIntervalMs: parsedEnv.SOCKET_IO_PING_INTERVAL_MS,
  socketIoPingTimeoutMs: parsedEnv.SOCKET_IO_PING_TIMEOUT_MS,
  socketIoUpgradeTimeoutMs: parsedEnv.SOCKET_IO_UPGRADE_TIMEOUT_MS,
  socketIoRedisAdapterKey: parsedEnv.SOCKET_IO_REDIS_ADAPTER_KEY,
  socketIoRedisAdapterRequestsTimeoutMs: parsedEnv.SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS,
  socketIoRedisAdapterPublishOnSpecificResponseChannel:
    parsedEnv.SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL,
  socketIoRedisAdapterConnectTimeoutMs: parsedEnv.SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS,
  socketIoRedisAdapterReconnectBaseMs: parsedEnv.SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS,
  socketIoRedisAdapterReconnectMaxMs: parsedEnv.SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS,
  agentHubPresenceRedisUrl: agentHubPresenceRedisUrlResolved,
  agentHubPresenceEnabled,
  agentHubPresenceTtlMs: parsedEnv.AGENT_HUB_PRESENCE_TTL_MS,
  agentHubBridgeForwardTimeoutMs: parsedEnv.AGENT_HUB_BRIDGE_FORWARD_TIMEOUT_MS,
  agentHubClusterInstanceIds: parsedEnv.AGENT_HUB_CLUSTER_INSTANCE_IDS.split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0),
  redisDefaultConnectTimeoutMs: parsedEnv.REDIS_DEFAULT_CONNECT_TIMEOUT_MS,
  redisDefaultReconnectBaseMs: parsedEnv.REDIS_DEFAULT_RECONNECT_BASE_MS,
  redisDefaultReconnectMaxMs: parsedEnv.REDIS_DEFAULT_RECONNECT_MAX_MS,
  redisRateLimitCircuitFailureThreshold: parsedEnv.REDIS_RATE_LIMIT_CIRCUIT_FAILURE_THRESHOLD,
  redisRateLimitCircuitOpenMs: parsedEnv.REDIS_RATE_LIMIT_CIRCUIT_OPEN_MS,
  strictRedisAuth: parsedEnv.STRICT_REDIS_AUTH,
  redisTenantId: parsedEnv.REDIS_TENANT_ID,
  agentEventStreamRedisUrl: parsedEnv.AGENT_EVENT_STREAM_REDIS_URL,
  agentEventStreamEnabled: parsedEnv.AGENT_EVENT_STREAM_ENABLED,
  agentEventStreamMaxLen: parsedEnv.AGENT_EVENT_STREAM_MAX_LEN,
  agentEventStreamTtlMs: parsedEnv.AGENT_EVENT_STREAM_TTL_MS,
  agentEventStreamBacklogMaxEntries: parsedEnv.AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES,
  agentEventStreamAgentAllowlist: parsedEnv.AGENT_EVENT_STREAM_AGENT_ALLOWLIST.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== ""),
  agentEventStreamDrainAckTimeoutMs: parsedEnv.AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS,
  agentEventStreamUseConsumerGroups: parsedEnv.AGENT_EVENT_STREAM_USE_CONSUMER_GROUPS,
  agentEventStreamConsumerGroup: parsedEnv.AGENT_EVENT_STREAM_CONSUMER_GROUP,
  agentEventStreamAppendMode: parsedEnv.AGENT_EVENT_STREAM_APPEND_MODE,
  agentEventStreamAppendTimeoutMs: parsedEnv.AGENT_EVENT_STREAM_APPEND_TIMEOUT_MS,
  socketAuditRetentionDays: parsedEnv.SOCKET_AUDIT_RETENTION_DAYS,
  socketAuditRetentionIntervalMinutes: parsedEnv.SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES,
  socketAuditPruneBatchSize: parsedEnv.SOCKET_AUDIT_PRUNE_BATCH_SIZE,
  socketAuditBatchMax: parsedEnv.SOCKET_AUDIT_BATCH_MAX,
  socketAuditBatchFlushMs: parsedEnv.SOCKET_AUDIT_BATCH_FLUSH_MS,
  socketAuditMaxQueue: parsedEnv.SOCKET_AUDIT_MAX_QUEUE,
  socketAuditHighVolumeSamplePercent: parsedEnv.SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT,
  swaggerEnabled: parsedEnv.SWAGGER_ENABLED,
  restAgentsCommandsRateLimitWindowMs: parsedEnv.REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS,
  restAgentsCommandsRateLimitMax: parsedEnv.REST_AGENTS_COMMANDS_RATE_LIMIT_MAX,
  restAgentsSelfProfileRateLimitWindowMs: parsedEnv.REST_AGENTS_SELF_PROFILE_RATE_LIMIT_WINDOW_MS,
  restAgentsSelfProfileRateLimitMax: parsedEnv.REST_AGENTS_SELF_PROFILE_RATE_LIMIT_MAX,
  socketAgentsCommandRateLimitWeightedCosts:
    parsedEnv.SOCKET_AGENTS_COMMAND_RATE_LIMIT_WEIGHTED_COSTS,
  restAgentsCommandsRateLimitIpMax: parsedEnv.REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX,
  agentAccessCacheTtlMs: parsedEnv.AGENT_ACCESS_CACHE_TTL_MS,
  agentAccessCacheMaxSize: parsedEnv.AGENT_ACCESS_CACHE_MAX_SIZE,
  principalSnapshotCacheTtlMs: parsedEnv.PRINCIPAL_SNAPSHOT_CACHE_TTL_MS,
  principalSnapshotCacheMaxSize: parsedEnv.PRINCIPAL_SNAPSHOT_CACHE_MAX_SIZE,
  restAdminUserStatusRateLimitWindowMs: parsedEnv.REST_ADMIN_USER_STATUS_RATE_LIMIT_WINDOW_MS,
  restAdminUserStatusRateLimitMax: parsedEnv.REST_ADMIN_USER_STATUS_RATE_LIMIT_MAX,
  bridgeLogJsonRpcAutoId: parsedEnv.BRIDGE_LOG_JSONRPC_AUTO_ID,
  bridgeLatencyTraceEnabled: parsedEnv.BRIDGE_LATENCY_TRACE_ENABLED,
  bridgeLatencyTraceSamplePercent: parsedEnv.BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT,
  bridgeLatencyTraceBatchMax: parsedEnv.BRIDGE_LATENCY_TRACE_BATCH_MAX,
  bridgeLatencyTraceBatchFlushMs: parsedEnv.BRIDGE_LATENCY_TRACE_BATCH_FLUSH_MS,
  bridgeLatencyTraceMaxQueue: parsedEnv.BRIDGE_LATENCY_TRACE_MAX_QUEUE,
  bridgeLatencyTraceSlowTotalMs: parsedEnv.BRIDGE_LATENCY_TRACE_SLOW_TOTAL_MS,
  bridgeLatencyTraceRetentionDays: parsedEnv.BRIDGE_LATENCY_TRACE_RETENTION_DAYS,
  bridgeLatencyTraceRetentionIntervalMinutes:
    parsedEnv.BRIDGE_LATENCY_TRACE_RETENTION_INTERVAL_MINUTES,
  bridgeLatencyTracePruneBatchSize: parsedEnv.BRIDGE_LATENCY_TRACE_PRUNE_BATCH_SIZE,
  bridgeLatencyTraceRollupRefreshIntervalMinutes:
    parsedEnv.BRIDGE_LATENCY_TRACE_ROLLUP_REFRESH_INTERVAL_MINUTES,
  bridgeLatencyTraceOtelEnabled: parsedEnv.BRIDGE_LATENCY_TRACE_OTEL_ENABLED,
  bridgeLatencyTracePhasesMismatchWarnMs: parsedEnv.BRIDGE_LATENCY_TRACE_PHASES_MISMATCH_WARN_MS,
  bridgeLatencyTraceRedactUserId: parsedEnv.BRIDGE_LATENCY_TRACE_REDACT_USER_ID,
  bridgeLatencyTraceTruncateRequestIdChars:
    parsedEnv.BRIDGE_LATENCY_TRACE_TRUNCATE_REQUEST_ID_CHARS,
  bridgeLatencyTraceRelayRetentionDays:
    parsedEnv.BRIDGE_LATENCY_TRACE_RELAY_RETENTION_DAYS ??
    parsedEnv.BRIDGE_LATENCY_TRACE_RETENTION_DAYS,
  agentProfileRevisionRetentionDays: parsedEnv.AGENT_PROFILE_REVISION_RETENTION_DAYS,
  agentProfileIdempotencyRetentionDays: parsedEnv.AGENT_PROFILE_IDEMPOTENCY_RETENTION_DAYS,
  agentProfileMaintenanceIntervalMinutes: parsedEnv.AGENT_PROFILE_MAINTENANCE_INTERVAL_MINUTES,
  agentProfileMaintenancePruneBatchSize: parsedEnv.AGENT_PROFILE_MAINTENANCE_PRUNE_BATCH_SIZE,
  clientAgentAccessExpirySweepIntervalMinutes:
    parsedEnv.CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_INTERVAL_MINUTES,
  clientAgentAccessExpirySweepBatchSize: parsedEnv.CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_BATCH_SIZE,
  appBaseUrl: parsedEnv.APP_BASE_URL.replace(/\/+$/, ""),
  adminEmail: parsedEnv.ADMIN_EMAIL,
  smtpHost: parsedEnv.SMTP_HOST,
  smtpPort: parsedEnv.SMTP_PORT,
  smtpUser: parsedEnv.SMTP_USER,
  smtpPass: parsedEnv.SMTP_PASS,
  smtpFrom: parsedEnv.SMTP_FROM,
  approvalTokenExpiresIn: parsedEnv.APPROVAL_TOKEN_EXPIRES_IN,
  clientPasswordRecoveryTokenExpiresIn: parsedEnv.CLIENT_PASSWORD_RECOVERY_TOKEN_EXPIRES_IN,
  requireSmtpInProduction: parsedEnv.REQUIRE_SMTP_IN_PRODUCTION,
  registrationEmailAsync: parsedEnv.REGISTRATION_EMAIL_ASYNC,
  registrationEmailMaxRetries: parsedEnv.REGISTRATION_EMAIL_MAX_RETRIES,
  registrationEmailRetryDelayMs: parsedEnv.REGISTRATION_EMAIL_RETRY_DELAY_MS,
  registrationEmailOutboxEnabled: parsedEnv.REGISTRATION_EMAIL_OUTBOX_ENABLED,
  registrationEmailOutboxPollIntervalMs: parsedEnv.REGISTRATION_EMAIL_OUTBOX_POLL_INTERVAL_MS,
  registrationEmailOutboxBatchSize: parsedEnv.REGISTRATION_EMAIL_OUTBOX_BATCH_SIZE,
  registrationEmailOutboxMaxAttempts: parsedEnv.REGISTRATION_EMAIL_OUTBOX_MAX_ATTEMPTS,
  registrationEmailOutboxRetryBaseDelayMs: parsedEnv.REGISTRATION_EMAIL_OUTBOX_RETRY_BASE_DELAY_MS,
  registrationEmailOutboxLockTimeoutMs: parsedEnv.REGISTRATION_EMAIL_OUTBOX_LOCK_TIMEOUT_MS,
  registrationEmailOutboxWorkerConcurrency: parsedEnv.REGISTRATION_EMAIL_OUTBOX_WORKER_CONCURRENCY,
  registrationEmailOutboxDeadLetterRetentionDays:
    parsedEnv.REGISTRATION_EMAIL_OUTBOX_DEAD_LETTER_RETENTION_DAYS,
  registrationEmailOutboxDeadLetterPruneIntervalMinutes:
    parsedEnv.REGISTRATION_EMAIL_OUTBOX_DEAD_LETTER_PRUNE_INTERVAL_MINUTES,
} as const;
