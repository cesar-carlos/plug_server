import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as RedisSpanModuleNs from "../../../../src/infrastructure/observability/redis_span";

const setupModule = async (
  flags: { readonly otelTracesEnabled?: boolean; readonly redisOtelSpansEnabled?: boolean } = {},
): Promise<{
  readonly module: typeof RedisSpanModuleNs;
  readonly startActiveSpan: ReturnType<typeof vi.fn>;
}> => {
  vi.resetModules();
  const startActiveSpan = vi.fn(
    (
      _name: string,
      fn: (span: {
        setAttribute: () => void;
        setStatus: () => void;
        recordException: () => void;
        end: () => void;
      }) => unknown,
    ) =>
      fn({
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      }),
  );
  vi.doMock("@opentelemetry/api", () => ({
    trace: { getTracer: () => ({ startActiveSpan }) },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  }));
  vi.doMock("../../../../src/shared/config/env", () => ({
    env: {
      otelTracesEnabled: flags.otelTracesEnabled ?? false,
      redisOtelSpansEnabled: flags.redisOtelSpansEnabled ?? false,
    },
  }));
  const module = await import("../../../../src/infrastructure/observability/redis_span");
  return { module, startActiveSpan };
};

describe("withRedisSpan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("@opentelemetry/api");
    vi.doUnmock("../../../../src/shared/config/env");
  });

  it("calls fn directly without creating a span when both flags are false", async () => {
    const { module, startActiveSpan } = await setupModule({});
    const fn = vi.fn(async () => "ok");
    const result = await module.withRedisSpan({ module: "m", op: "o" }, fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
    expect(startActiveSpan).not.toHaveBeenCalled();
  });

  it("calls fn directly when REDIS_OTEL_SPANS_ENABLED=false even with traces enabled", async () => {
    const { module, startActiveSpan } = await setupModule({
      otelTracesEnabled: true,
      redisOtelSpansEnabled: false,
    });
    const fn = vi.fn(async () => "ok");
    await module.withRedisSpan({ module: "m", op: "o" }, fn);
    expect(startActiveSpan).not.toHaveBeenCalled();
  });

  it("creates a span when both flags are true and returns the inner result", async () => {
    const { module, startActiveSpan } = await setupModule({
      otelTracesEnabled: true,
      redisOtelSpansEnabled: true,
    });
    const fn = vi.fn(async () => 42);
    const result = await module.withRedisSpan(
      { module: "socket_rate_limit_redis", op: "consume", keyPrefix: "plug_socket_rl" },
      fn,
    );
    expect(result).toBe(42);
    expect(startActiveSpan).toHaveBeenCalledOnce();
    expect(startActiveSpan.mock.calls[0]?.[0]).toBe("redis.socket_rate_limit_redis.consume");
  });

  it("re-throws errors from fn after recording the exception", async () => {
    const { module } = await setupModule({
      otelTracesEnabled: true,
      redisOtelSpansEnabled: true,
    });
    const error = new Error("boom");
    await expect(
      module.withRedisSpan({ module: "m", op: "o" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
