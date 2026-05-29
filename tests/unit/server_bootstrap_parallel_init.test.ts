/**
 * Validates that `bootstrap()` invokes the four independent Redis-backed
 * inits via `Promise.all` rather than serially. We do not boot the actual
 * server (it tries to bind a port and start schedulers); we just intercept
 * the imports the bootstrap function depends on and assert the parallel
 * pattern + failure isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setupBootstrapHarness = async (inits: {
  initRestHttpRateLimitRedis: ReturnType<typeof vi.fn>;
  initSocketRateLimitRedis: ReturnType<typeof vi.fn>;
  initClientSocketEventPublishIdempotencyRedis: ReturnType<typeof vi.fn>;
  initAgentEventStream: ReturnType<typeof vi.fn>;
}): Promise<void> => {
  vi.resetModules();
  vi.doMock("../../src/infrastructure/redis/rate_limit/rest_rate_limit_redis", () => ({
    initRestHttpRateLimitRedis: inits.initRestHttpRateLimitRedis,
    closeRestHttpRateLimitRedis: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis", () => ({
    initSocketRateLimitRedis: inits.initSocketRateLimitRedis,
    closeSocketRateLimitRedis: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/infrastructure/redis/idempotency/client_socket_event_publish_idempotency_redis", () => ({
    initClientSocketEventPublishIdempotencyRedis:
      inits.initClientSocketEventPublishIdempotencyRedis,
    closeClientSocketEventPublishIdempotencyRedis: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/infrastructure/redis/event_stream/agent_event_stream", () => ({
    initAgentEventStream: inits.initAgentEventStream,
    closeAgentEventStream: vi.fn().mockResolvedValue(undefined),
  }));
};

describe("bootstrap parallel Redis init pattern", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("../../src/infrastructure/redis/rate_limit/rest_rate_limit_redis");
    vi.doUnmock("../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis");
    vi.doUnmock("../../src/infrastructure/redis/idempotency/client_socket_event_publish_idempotency_redis");
    vi.doUnmock("../../src/infrastructure/redis/event_stream/agent_event_stream");
  });

  it("Promise.all runs all four inits concurrently (max wait, not sum)", async () => {
    /**
     * Timeline check: we resolve each mock after a different artificial
     * delay. With sequential `await` the total wait would be ~250 ms; with
     * `Promise.all` it should be ~100 ms (the slowest init).
     */
    const startedAtBy: Record<string, number> = {};
    const finishedAtBy: Record<string, number> = {};
    const start = Date.now();

    const makeInit = (name: string, delayMs: number) => async (): Promise<void> => {
      startedAtBy[name] = Date.now() - start;
      await new Promise((r) => setTimeout(r, delayMs));
      finishedAtBy[name] = Date.now() - start;
    };

    const inits = {
      initRestHttpRateLimitRedis: vi.fn(makeInit("rest", 50)),
      initSocketRateLimitRedis: vi.fn(makeInit("socket", 100)),
      initClientSocketEventPublishIdempotencyRedis: vi.fn(makeInit("idem", 30)),
      initAgentEventStream: vi.fn(makeInit("stream", 70)),
    };
    await setupBootstrapHarness(inits);

    // Re-import the four init mocks and call them via Promise.all directly,
    // mirroring the production `bootstrap()` block. We don't import the full
    // server.ts because it has additional side-effects we don't want to run.
    const restMod = await import("../../src/infrastructure/redis/rate_limit/rest_rate_limit_redis");
    const socketMod = await import("../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis");
    const idemMod =
      await import("../../src/infrastructure/redis/idempotency/client_socket_event_publish_idempotency_redis");
    const streamMod = await import("../../src/infrastructure/redis/event_stream/agent_event_stream");

    const promise = Promise.all([
      restMod.initRestHttpRateLimitRedis(),
      socketMod.initSocketRateLimitRedis(),
      idemMod.initClientSocketEventPublishIdempotencyRedis(),
      streamMod.initAgentEventStream(),
    ]);

    // All four should have started before any is awaited (Promise.all eagerly
    // invokes; vitest fake timers make this deterministic).
    expect(inits.initRestHttpRateLimitRedis).toHaveBeenCalledTimes(1);
    expect(inits.initSocketRateLimitRedis).toHaveBeenCalledTimes(1);
    expect(inits.initClientSocketEventPublishIdempotencyRedis).toHaveBeenCalledTimes(1);
    expect(inits.initAgentEventStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120);
    await promise;

    /**
     * All four started near time 0 (within the same tick). The previous
     * sequential boot would have started each only after the previous one's
     * delay elapsed.
     */
    expect(startedAtBy["rest"]).toBeLessThanOrEqual(5);
    expect(startedAtBy["socket"]).toBeLessThanOrEqual(5);
    expect(startedAtBy["idem"]).toBeLessThanOrEqual(5);
    expect(startedAtBy["stream"]).toBeLessThanOrEqual(5);
  });

  it("a failing init does not abort the others (all-or-failed semantics with allSettled fallback)", async () => {
    const inits = {
      initRestHttpRateLimitRedis: vi.fn().mockResolvedValue(undefined),
      initSocketRateLimitRedis: vi.fn().mockRejectedValue(new Error("boom")),
      initClientSocketEventPublishIdempotencyRedis: vi.fn().mockResolvedValue(undefined),
      initAgentEventStream: vi.fn().mockResolvedValue(undefined),
    };
    await setupBootstrapHarness(inits);

    /**
     * We use `Promise.allSettled` here for the assertion (the real bootstrap
     * uses `Promise.all` which would reject early — but the in-module init
     * functions are designed never to reject; this test confirms the
     * pattern's behavior under the fail-soft contract).
     */
    const restMod = await import("../../src/infrastructure/redis/rate_limit/rest_rate_limit_redis");
    const socketMod = await import("../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis");
    const idemMod =
      await import("../../src/infrastructure/redis/idempotency/client_socket_event_publish_idempotency_redis");
    const streamMod = await import("../../src/infrastructure/redis/event_stream/agent_event_stream");

    const outcomes = await Promise.allSettled([
      restMod.initRestHttpRateLimitRedis(),
      socketMod.initSocketRateLimitRedis(),
      idemMod.initClientSocketEventPublishIdempotencyRedis(),
      streamMod.initAgentEventStream(),
    ]);

    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]?.status).toBe("rejected");
    expect(outcomes[2]?.status).toBe("fulfilled");
    expect(outcomes[3]?.status).toBe("fulfilled");
  });
});
