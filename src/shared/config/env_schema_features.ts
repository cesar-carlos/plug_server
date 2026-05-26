import { z } from "zod";

const isProductionNodeEnv = (): boolean => process.env.NODE_ENV === "production";

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

export const envFeaturesShape = {
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
   * When > 0, hub→agent `encodePayloadFrameBridge` uses async zlib for gzip-eligible JSON at least
   * this many UTF-8 bytes (offloads CPU from the event loop). 0 = always synchronous gzip.
   */
  PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024)
    .default(131_072),
  /**
   * When > 0 and `cmp === gzip`, inbound `decodePayloadFrameAsync` uses async gunzip for compressed
   * payloads at least this many bytes. 0 = always synchronous gunzip.
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
   * (legacy unlimited behaviour, OOM risk under DB stalls).
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
  /** If |total_ms - phases_sum_ms| exceeds this, increment metric and log at debug (0 = off). */
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
  /** Retention for `channel = relay` only. If unset/empty, uses `BRIDGE_LATENCY_TRACE_RETENTION_DAYS`. */
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
} as const;
