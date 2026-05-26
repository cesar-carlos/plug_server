import { z } from "zod";

const isProductionNodeEnv = (): boolean => process.env.NODE_ENV === "production";

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

export const envSocketShape = {
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
   * When > 0, successful `bindOwnershipOnRegister(userId, agentId)` skip repeated DB work until TTL.
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
  /** Background sweep cadence for `SOCKET_AGENT_IDLE_TIMEOUT_MS`. `0` disables the scheduler. */
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
  /** Background sweep cadence for `SOCKET_CONSUMER_IDLE_TIMEOUT_MS`. `0` disables the scheduler. */
  SOCKET_CONSUMER_IDLE_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(60_000),
  /**
   * When > 0, successful `/agents` and `/consumers` handshake DB checks may be skipped for the same
   * JWT `sub` + `credentials_version` + principal type until the TTL expires.
   * Block/unblock can be delayed by up to this window; use `0` (default) to always hit the DB.
   */
  SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  /**
   * When > 0, successful consumer agent-access guards may skip `assertPrincipalAccess` on the
   * same socket+agent until the TTL expires. Revokes/grants can be delayed by up to this window.
   */
  SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(0),
  /**
   * Hard cap on async operations a single consumer socket may have in flight at once.
   * Set `0` to disable the gate (legacy behaviour: unbounded inflight per socket).
   */
  SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET: z.coerce.number().int().min(0).max(10_000).default(32),
  /**
   * Dedicated async cap for `socket:event.publish` only. When `0` (default), publish shares
   * `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET` with relay/command handlers.
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
   * Toggle for the `client:agent.profile.updated` push that notifies approved clients.
   * Set `false` as an operational kill-switch without disabling the rest of the consumer namespace.
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
   * `0` disables the sweep.
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
   * Per-conversation cap on relay idempotency entries. When exceeded, the oldest entry is evicted (FIFO).
   */
  SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION: z.coerce
    .number()
    .int()
    .positive()
    .max(100_000)
    .default(1_024),
  /**
   * Global cap (across all conversations) on relay idempotency entries. `0` disables the global cap.
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
   * Per consumer identity per `SOCKET_RELAY_RATE_LIMIT_WINDOW_MS`. `0` disables this limiter.
   */
  SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(8),
  /** Per consumer identity per window. `0` disables. */
  SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(0).max(10_000_000).default(64),
  /** Credits granted per window for `relay:rpc.stream.pull`. `0` disables. */
  SOCKET_RELAY_RATE_LIMIT_MAX_STREAM_PULL_CREDITS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(1000),
  SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER: z.coerce.number().positive().default(3),
  /** Max concurrent relay RPC dispatches per agent id. `0` = unlimited. */
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
  /**
   * Transitional wire compatibility mode for the `/consumers` `agents:command` family.
   * `payload_frame` is the default/current contract; `raw_json` exists only as a short-lived shim.
   */
  SOCKET_AGENTS_COMMAND_COMPAT_MODE: z.enum(["payload_frame", "raw_json"]).default("payload_frame"),
  /**
   * Transitional wire compatibility mode for the `/consumers` `agents:stream_pull` family.
   * Independent from `SOCKET_AGENTS_COMMAND_COMPAT_MODE` so command and stream_pull can migrate separately.
   */
  SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE: z
    .enum(["payload_frame", "raw_json"])
    .default("payload_frame"),
  SOCKET_REST_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(10_000),
  /** Max concurrent REST→agent RPC dispatches per agent id. `0` = unlimited. */
  SOCKET_REST_AGENT_MAX_INFLIGHT: z.coerce.number().int().min(0).max(10_000).default(32),
  /** Max waiters when inflight is saturated. `0` = unlimited queue depth. */
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
   * Max aggregated rows allowed when REST materializes a streaming `sql.execute`.
   * `0` disables the limit (not recommended for large deployments).
   */
  SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(1_000_000),
  /**
   * Max `rpc:chunk` frames accepted during REST materialization. `0` = unlimited.
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
   * `0` disables the byte cap. Default 256 MiB matches Node default `--max-old-space-size` headroom.
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
  /** When false, disables WebSocket permessage-deflate (PayloadFrame already handles gzip at app layer). */
  SOCKET_IO_PER_MESSAGE_DEFLATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Comma-separated: `websocket`, `polling`. If unset: `websocket` only when NODE_ENV=production.
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
   * Engine.IO compression for long-polling responses.
   * If unset: `false` when NODE_ENV=production (saves CPU with websocket-only default).
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
   * Matches library default (`false`).
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
   * Percentage (0–100) of `relay:rpc.chunk` audit events persisted.
   * If unset: 25 in production, 100 otherwise.
   */
  SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT: z.preprocess((val) => {
    if (val !== undefined && val !== "" && String(val).trim() !== "") {
      return val;
    }
    return isProductionNodeEnv() ? "25" : "100";
  }, z.coerce.number().int().min(0).max(100)),
} as const;
