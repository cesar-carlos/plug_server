import { z } from "zod";

export const envHttpShape = {
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
   * Per-IP rate-limit for credential-handling endpoints (password-based).
   * Token rotation uses `REST_TOKEN_REFRESH_RATE_LIMIT_*` instead.
   */
  REST_CREDENTIAL_AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  /** `0` = unlimited. */
  REST_CREDENTIAL_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(25),
  /**
   * Per-IP rate-limit for `POST /auth/refresh` and `POST /client-auth/refresh` only.
   * Higher defaults than credential routes so many agents behind one NAT can rotate tokens after outages.
   */
  REST_TOKEN_REFRESH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  /** `0` = unlimited. */
  REST_TOKEN_REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(400),
  /**
   * Optional Redis URL for HTTP rate limits (`express-rate-limit` + `rate-limit-redis`).
   * Empty = default in-memory store (per process).
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
   * Hint `retry_after_ms` when local fan-out exceeds `REST_SOCKET_EVENT_MAX_RECIPIENTS`.
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
   * `0` = unlimited.
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
   * Express `express.json` limit for JSON-only `POST /api/v1/client/me/socket-events` (not global).
   * Empty: derive ~110% of worst-case UTF-8 envelope from `REST_SOCKET_EVENT_*` payload + attachment caps.
   */
  REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val).trim()),
    z.string(),
  ),
  /**
   * Optional fixed-window (ms) for `socket:event.publish` only. When unset/empty, mirrors
   * `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`.
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
   * does not re-email the owner (returns `debounced`). `0` disables debouncing.
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
  REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max requests per window per authenticated user (JWT `sub`). `0` = unlimited (HTTP + socket consumer). */
  REST_AGENTS_COMMANDS_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(100),
  /**
   * Sliding window (ms) for `PATCH /agents/:agentId/profile` per authenticated agent.
   */
  REST_AGENTS_SELF_PROFILE_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
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
   * Optional second limiter on `POST /agents/commands` keyed by `req.ip`.
   * `0` disables.
   */
  REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX: z.coerce.number().int().nonnegative().default(0),
  /**
   * TTL (ms) for the in-process agent-access cache in `AgentAccessService`.
   * `0` disables.
   */
  AGENT_ACCESS_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
  /** Max entries in the agent-access cache (oldest evicted first). `0` = unlimited. */
  AGENT_ACCESS_CACHE_MAX_SIZE: z.coerce.number().int().min(0).default(5_000),
  /**
   * TTL (ms) for the in-process principal active-snapshot cache in `AuthService`
   * and `ClientAuthService`. `0` disables.
   *
   * Security note: a blocked account continues to pass the snapshot check until the entry expires.
   */
  PRINCIPAL_SNAPSHOT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(15_000),
  /** Max entries in the principal snapshot cache. `0` = unlimited. */
  PRINCIPAL_SNAPSHOT_CACHE_MAX_SIZE: z.coerce.number().int().min(0).default(2_000),
  /** Window for `PATCH /admin/users/:id/status` per admin (`JWT sub`). */
  REST_ADMIN_USER_STATUS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max status changes per window per admin. `0` = unlimited. */
  REST_ADMIN_USER_STATUS_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000_000).default(60),
} as const;
