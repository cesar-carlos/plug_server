/**
 * Named OpenTelemetry spans for Redis hot-path commands.
 *
 * Auto-instrumentation already creates generic redis spans (`redis.eval`,
 * `redis.xadd`, etc.); this helper layers **module-aware** spans on top so
 * dashboards can split latency by hub concern (rate-limit vs idempotency
 * vs streams) without parsing the underlying Redis command shape.
 *
 * Activation requires both:
 *   - `OTEL_TRACES_ENABLED=true` (the SDK is bootstrapped at all)
 *   - `REDIS_OTEL_SPANS_ENABLED=true`
 *
 * Either flag false reduces this to a direct `fn()` call with zero
 * allocations from the OTel SDK.
 *
 * Span attribute conventions (PII-safe):
 *   - `redis.module`    — `socket_rate_limit_redis`, `agent_event_stream`, etc.
 *   - `redis.op`        — `consume`, `refund`, `lock`, `unlock`, `extend`,
 *                         `xadd`, `xreadgroup`, `xack`, `set`, `get`.
 *   - `redis.key.prefix`— first segment of the key (e.g. `plug_socket_rl`),
 *                         never the principal id / digest / scope value.
 */

import { trace, type Span, SpanStatusCode } from "@opentelemetry/api";

import { env } from "../../shared/config/env";

const TRACER_NAME = "plug.redis";

const tracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer(TRACER_NAME);

export interface RedisSpanInput {
  readonly module: string;
  readonly op: string;
  /** Optional key prefix snippet for filtering. NEVER pass user-supplied content. */
  readonly keyPrefix?: string;
}

const isEnabled = (): boolean => env.otelTracesEnabled && env.redisOtelSpansEnabled;

const setSpanAttrs = (span: Span, input: RedisSpanInput): void => {
  span.setAttribute("redis.module", input.module);
  span.setAttribute("redis.op", input.op);
  if (input.keyPrefix !== undefined) {
    span.setAttribute("redis.key.prefix", input.keyPrefix);
  }
};

/**
 * Wraps `fn` in a span whose name is `redis.${module}.${op}`. Returns the
 * underlying `fn()` result on success; on error, sets the span status to
 * `ERROR`, records the exception, and re-throws so the caller's existing
 * error handling path is preserved.
 */
export const withRedisSpan = async <T>(input: RedisSpanInput, fn: () => Promise<T>): Promise<T> => {
  if (!isEnabled()) {
    return fn();
  }
  const spanName = `redis.${input.module}.${input.op}`;
  return tracer().startActiveSpan(spanName, async (span) => {
    setSpanAttrs(span, input);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
};
