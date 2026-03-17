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
  SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST: z.coerce.number().int().positive().default(100),
  SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS: z.coerce.number().int().positive().default(10_000),
  SOCKET_RELAY_IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(300_000),
  SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  SOCKET_RELAY_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  SOCKET_RELAY_METRICS_LOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SOCKET_RELAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS: z.coerce.number().int().positive().default(8),
  SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(40),
  SOCKET_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  SOCKET_AUDIT_PRUNE_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),
  SWAGGER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
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
  socketRelayCircuitFailureThreshold: parsedEnv.SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD,
  socketRelayCircuitOpenMs: parsedEnv.SOCKET_RELAY_CIRCUIT_OPEN_MS,
  socketRelayMetricsLogIntervalMs: parsedEnv.SOCKET_RELAY_METRICS_LOG_INTERVAL_MS,
  socketRelayRateLimitWindowMs: parsedEnv.SOCKET_RELAY_RATE_LIMIT_WINDOW_MS,
  socketRelayRateLimitMaxConversationStarts:
    parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS,
  socketRelayRateLimitMaxRequests: parsedEnv.SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS,
  socketAuditRetentionDays: parsedEnv.SOCKET_AUDIT_RETENTION_DAYS,
  socketAuditRetentionIntervalMinutes: parsedEnv.SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES,
  socketAuditPruneBatchSize: parsedEnv.SOCKET_AUDIT_PRUNE_BATCH_SIZE,
  swaggerEnabled: parsedEnv.SWAGGER_ENABLED,
} as const;
