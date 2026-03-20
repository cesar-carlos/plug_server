import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  APP_NAME: z.string().default("plug_server"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default("*"),
  REQUEST_BODY_LIMIT: z.string().default("1mb"),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16).default("change-me-access-development"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_SECRET: z.string().min(16).default("change-me-refresh-development"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().min(1).default("plug_server"),
  JWT_AUDIENCE: z.string().min(1).default("plug_clients"),
  PAYLOAD_SIGNING_KEY: z.string().optional(),
  PAYLOAD_SIGNING_KEY_ID: z.string().optional(),
  PAYLOAD_SIGN_OUTBOUND: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SOCKET_AUTH_REQUIRED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SOCKET_AGENT_ROLES: z
    .string()
    .default("agent")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  SOCKET_CONSUMER_ROLES: z
    .string()
    .default("user,admin")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  SOCKET_RELAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  SOCKET_RELAY_CONVERSATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SOCKET_RELAY_MAX_CONVERSATIONS: z.coerce.number().int().positive().default(5_000),
  SOCKET_RELAY_MAX_CONVERSATIONS_PER_CONSUMER: z.coerce.number().int().positive().default(20),
  SOCKET_RELAY_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(10_000),
  SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONVERSATION: z.coerce.number().int().positive().default(32),
  SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONSUMER: z.coerce.number().int().positive().default(128),
  SOCKET_RELAY_MAX_ACTIVE_STREAMS: z.coerce.number().int().positive().default(5_000),
  SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST: z.coerce.number().int().positive().default(128),
  SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS: z.coerce.number().int().positive().default(12_800),
  SOCKET_RELAY_IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(300_000),
  /** Background prune of relay idempotency maps; larger interval = less CPU, slower reclamation of empty maps. */
  SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  SOCKET_RELAY_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  SOCKET_RELAY_METRICS_LOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SOCKET_RELAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS: z.coerce.number().int().positive().default(8),
  SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(64),
  SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER: z.coerce.number().positive().default(3),
  SOCKET_REST_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(10_000),
  SOCKET_REST_AGENT_MAX_INFLIGHT: z.coerce.number().int().positive().default(24),
  SOCKET_REST_AGENT_MAX_QUEUE: z.coerce.number().int().nonnegative().default(48),
  SOCKET_REST_AGENT_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(200),
  /** Window size for automatic `rpc:stream.pull` when the REST bridge materializes a streaming `sql.execute` result. */
  SOCKET_REST_STREAM_PULL_WINDOW_SIZE: z.coerce.number().int().positive().max(10_000).default(96),
  /**
   * Max Engine.IO packet size (bytes). Must fit PayloadFrame compressed ceiling (10 MB).
   * Default 10 MiB matches `payload_frame` limits.
   */
  SOCKET_IO_MAX_HTTP_BUFFER_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(10 * 1024 * 1024),
  /**
   * When false, disables WebSocket permessage-deflate (PayloadFrame already handles gzip at app layer).
   */
  SOCKET_IO_PER_MESSAGE_DEFLATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Comma-separated: `websocket`, `polling`. Example: `websocket` only in production for lower latency.
   */
  SOCKET_IO_TRANSPORTS: z
    .string()
    .default("websocket,polling")
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
  SOCKET_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  SOCKET_AUDIT_PRUNE_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),
  /** Max events per DB transaction when > 1; 1 disables batching (legacy single INSERT). */
  SOCKET_AUDIT_BATCH_MAX: z.coerce.number().int().positive().max(500).default(32),
  SOCKET_AUDIT_BATCH_FLUSH_MS: z.coerce.number().int().positive().max(30_000).default(150),
  SWAGGER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max requests per window per authenticated user (JWT `sub`). */
  REST_AGENTS_COMMANDS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  /**
   * Optional second limiter on `POST /agents/commands` keyed by `req.ip` (same window as above).
   * `0` disables. Use behind `trust proxy` when the server is behind a reverse proxy.
   */
  REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX: z.coerce.number().int().nonnegative().default(0),
  BRIDGE_LOG_JSONRPC_AUTO_ID: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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
}

export const env = {
  appName: parsedEnv.APP_NAME,
  nodeEnv: parsedEnv.NODE_ENV,
  port: parsedEnv.PORT,
  corsOrigin: parsedEnv.CORS_ORIGIN,
  requestBodyLimit: parsedEnv.REQUEST_BODY_LIMIT,
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
  socketAuthRequired: parsedEnv.SOCKET_AUTH_REQUIRED,
  socketAgentRoles: parsedEnv.SOCKET_AGENT_ROLES,
  socketConsumerRoles: parsedEnv.SOCKET_CONSUMER_ROLES,
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
  socketRelayMaxBufferedChunksPerRequest:
    parsedEnv.SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST,
  socketRelayMaxTotalBufferedChunks: parsedEnv.SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS,
  socketRelayIdempotencyTtlMs: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_TTL_MS,
  socketRelayIdempotencyCleanupIntervalMs: parsedEnv.SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  socketRelayCircuitFailureThreshold: parsedEnv.SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD,
  socketRelayCircuitOpenMs: parsedEnv.SOCKET_RELAY_CIRCUIT_OPEN_MS,
  socketRelayMetricsLogIntervalMs: parsedEnv.SOCKET_RELAY_METRICS_LOG_INTERVAL_MS,
  socketRelayRateLimitWindowMs: parsedEnv.SOCKET_RELAY_RATE_LIMIT_WINDOW_MS,
  socketRelayRateLimitMaxConversationStarts:
    parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS,
  socketRelayRateLimitMaxRequests: parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS,
  socketRelayRateLimitSweepStaleMultiplier: parsedEnv.SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER,
  socketRestMaxPendingRequests: parsedEnv.SOCKET_REST_MAX_PENDING_REQUESTS,
  socketRestAgentMaxInflight: parsedEnv.SOCKET_REST_AGENT_MAX_INFLIGHT,
  socketRestAgentMaxQueue: parsedEnv.SOCKET_REST_AGENT_MAX_QUEUE,
  socketRestAgentQueueWaitMs: parsedEnv.SOCKET_REST_AGENT_QUEUE_WAIT_MS,
  socketRestStreamPullWindowSize: parsedEnv.SOCKET_REST_STREAM_PULL_WINDOW_SIZE,
  socketIoMaxHttpBufferBytes: parsedEnv.SOCKET_IO_MAX_HTTP_BUFFER_BYTES,
  socketIoPerMessageDeflate: parsedEnv.SOCKET_IO_PER_MESSAGE_DEFLATE,
  socketIoTransports: parsedEnv.SOCKET_IO_TRANSPORTS as ("websocket" | "polling")[],
  socketAuditRetentionDays: parsedEnv.SOCKET_AUDIT_RETENTION_DAYS,
  socketAuditRetentionIntervalMinutes: parsedEnv.SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES,
  socketAuditPruneBatchSize: parsedEnv.SOCKET_AUDIT_PRUNE_BATCH_SIZE,
  socketAuditBatchMax: parsedEnv.SOCKET_AUDIT_BATCH_MAX,
  socketAuditBatchFlushMs: parsedEnv.SOCKET_AUDIT_BATCH_FLUSH_MS,
  swaggerEnabled: parsedEnv.SWAGGER_ENABLED,
  restAgentsCommandsRateLimitWindowMs: parsedEnv.REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS,
  restAgentsCommandsRateLimitMax: parsedEnv.REST_AGENTS_COMMANDS_RATE_LIMIT_MAX,
  restAgentsCommandsRateLimitIpMax: parsedEnv.REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX,
  bridgeLogJsonRpcAutoId: parsedEnv.BRIDGE_LOG_JSONRPC_AUTO_ID,
} as const;
