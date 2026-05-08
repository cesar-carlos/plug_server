import dotenv from "dotenv";
import { z } from "zod";

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
  PAYLOAD_SIGN_OUTBOUND: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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
   * When > 0, successful `/agents` and `/consumers` handshake DB checks may be skipped for the same
   * JWT `sub` + `credentials_version` + principal type until the TTL expires (reduces DB load on reconnect storms).
   * Block/unblock can be delayed by up to this window; use `0` (default) to always hit the DB.
   */
  SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  /**
   * Hard cap on async operations a single consumer socket may have in flight at once
   * across all event handlers (`agents:command`, `relay:rpc.request`, `agents:stream_pull`,
   * `relay:rpc.stream.pull`). Excess events are rejected immediately with `RATE_LIMITED`
   * so a misbehaving client cannot accumulate unbounded async work in the bridge.
   * Set `0` to disable the gate (legacy behaviour: unbounded inflight per socket).
   */
  SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET: z.coerce.number().int().min(0).max(10_000).default(32),
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
  SOCKET_RELAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
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
   * Hard cap on aggregated UTF-8 bytes (estimated via `JSON.stringify`) materialized
   * for a single REST SQL stream. Complements `MAX_ROWS` for cases where individual
   * rows are large (JSONB blobs). `0` disables the byte cap. Default 256 MiB matches
   * Node default `--max-old-space-size` headroom.
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
}

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
  clientAgentAccessRequestEmailDebounceMs: parsedEnv.CLIENT_AGENT_ACCESS_REQUEST_EMAIL_DEBOUNCE_MS,
  clientAgentAccessMaxRetries: parsedEnv.CLIENT_AGENT_ACCESS_MAX_RETRIES,
  restClientPasswordRecoveryRateLimitWindowMs:
    parsedEnv.REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_WINDOW_MS,
  restClientPasswordRecoveryRateLimitMax: parsedEnv.REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX,
  databaseUrl: parsedEnv.DATABASE_URL,
  jwtAccessSecret: parsedEnv.JWT_ACCESS_SECRET,
  jwtAccessExpiresIn: parsedEnv.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshSecret: parsedEnv.JWT_REFRESH_SECRET,
  jwtRefreshExpiresIn: parsedEnv.JWT_REFRESH_EXPIRES_IN,
  jwtIssuer: parsedEnv.JWT_ISSUER,
  jwtAudience: parsedEnv.JWT_AUDIENCE,
  payloadSigningKey: parsedEnv.PAYLOAD_SIGNING_KEY,
  payloadSigningKeyId: parsedEnv.PAYLOAD_SIGNING_KEY_ID,
  payloadSignOutbound: parsedEnv.PAYLOAD_SIGN_OUTBOUND,
  payloadFrameMaxGzipInputBytes: parsedEnv.PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES,
  payloadFrameGzipLevel: parsedEnv.PAYLOAD_FRAME_GZIP_LEVEL,
  payloadFrameAutoGzipMinSavingsBytes: parsedEnv.PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES,
  payloadFrameAsyncGzipMinUtf8Bytes: parsedEnv.PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES,
  payloadFrameAsyncGunzipMinCompressedBytes:
    parsedEnv.PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES,
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
  socketAuthAccountSnapshotTtlMs: parsedEnv.SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS,
  socketConsumerMaxInflightPerSocket: parsedEnv.SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET,
  socketAgentRoles: parsedEnv.SOCKET_AGENT_ROLES,
  socketConsumerRoles: parsedEnv.SOCKET_CONSUMER_ROLES.roles,
  socketConsumerRolesClientAppended: parsedEnv.SOCKET_CONSUMER_ROLES.clientAppended,
  socketClientAgentProfilePushEnabled: parsedEnv.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED,
  socketRelayRequestTimeoutMs: parsedEnv.SOCKET_RELAY_REQUEST_TIMEOUT_MS,
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
  socketRelayIdempotencyTtlMs: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_TTL_MS,
  socketRelayIdempotencyCleanupIntervalMs: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  socketRelayIdempotencyMaxEntriesPerConversation:
    parsedEnv.SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION,
  socketRelayIdempotencyMaxTotalEntries: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES,
  socketRelayCircuitFailureThreshold: parsedEnv.SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD,
  socketRelayCircuitOpenMs: parsedEnv.SOCKET_RELAY_CIRCUIT_OPEN_MS,
  socketRelayMetricsLogIntervalMs: parsedEnv.SOCKET_RELAY_METRICS_LOG_INTERVAL_MS,
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
  socketAgentsStreamPullRateLimitMaxCredits:
    parsedEnv.SOCKET_AGENTS_STREAM_PULL_RATE_LIMIT_MAX_CREDITS,
  socketConnectionReadyCompatMode: parsedEnv.SOCKET_CONNECTION_READY_COMPAT_MODE,
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
  socketIoHttpCompression: parsedEnv.SOCKET_IO_HTTP_COMPRESSION,
  socketIoPingIntervalMs: parsedEnv.SOCKET_IO_PING_INTERVAL_MS,
  socketIoPingTimeoutMs: parsedEnv.SOCKET_IO_PING_TIMEOUT_MS,
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
  registrationEmailOutboxDeadLetterRetentionDays:
    parsedEnv.REGISTRATION_EMAIL_OUTBOX_DEAD_LETTER_RETENTION_DAYS,
  registrationEmailOutboxDeadLetterPruneIntervalMinutes:
    parsedEnv.REGISTRATION_EMAIL_OUTBOX_DEAD_LETTER_PRUNE_INTERVAL_MINUTES,
} as const;
