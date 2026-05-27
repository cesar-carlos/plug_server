import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import {
  noteSocketIoRedisAdapterConnected,
  noteSocketIoRedisAdapterDisconnected,
  resetSocketIoRedisAdapterMetricsForTests,
} from "../../../../../src/application/services/socket_io_redis_adapter_metrics.service";
import {
  noteRestRateLimitRedisCircuitOpened,
  noteRestRateLimitRedisConnected,
  resetRestRateLimitRedisMetricsForTests,
} from "../../../../../src/application/services/rest_rate_limit_redis_metrics.service";
import {
  noteSocketRateLimitRedisConnected,
  resetSocketRateLimitRedisMetricsForTests,
} from "../../../../../src/application/services/socket_rate_limit_redis_metrics.service";
import {
  noteClientSocketEventIdempotencyRedisConnected,
  resetClientSocketEventIdempotencyRedisMetricsForTests,
} from "../../../../../src/application/services/client_socket_event_idempotency_redis_metrics.service";
import {
  noteAgentEventStreamConnected,
  resetAgentEventStreamMetricsForTests,
} from "../../../../../src/application/services/agent_event_stream_metrics.service";
import { getRedisHealth } from "../../../../../src/presentation/http/controllers/health_redis.controller";

const buildResponse = (): {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
} => {
  const json = vi.fn();
  const status = vi.fn().mockReturnThis();
  const response = { status, json } as unknown as Response;
  return { response, status, json };
};

describe("/health/redis controller", () => {
  afterEach(() => {
    resetSocketIoRedisAdapterMetricsForTests();
    resetSocketRateLimitRedisMetricsForTests();
    resetRestRateLimitRedisMetricsForTests();
    resetClientSocketEventIdempotencyRedisMetricsForTests();
    resetAgentEventStreamMetricsForTests();
  });

  it("returns 200 with status=ok when every module is skipped (URLs empty)", () => {
    const { response, status, json } = buildResponse();
    getRedisHealth({} as Request, response);
    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0]?.[0];
    expect(payload.status).toBe("ok");
    for (const module of Object.values(payload.modules) as Array<{
      active: boolean;
      reason?: string;
    }>) {
      expect(module.active).toBe(false);
      expect(module.reason).toBe("skipped");
    }
  });

  it("returns 200 with status=ok when every active module is healthy", () => {
    noteSocketIoRedisAdapterConnected();
    noteSocketRateLimitRedisConnected();
    noteRestRateLimitRedisConnected();
    noteClientSocketEventIdempotencyRedisConnected();
    noteAgentEventStreamConnected();

    const { response, status, json } = buildResponse();
    getRedisHealth({} as Request, response);
    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0]?.[0];
    expect(payload.status).toBe("ok");
    expect(payload.modules.adapter.active).toBe(true);
    expect(payload.modules.socketRateLimit.active).toBe(true);
    expect(payload.modules.restRateLimit.active).toBe(true);
    expect(payload.modules.idempotency.active).toBe(true);
    expect(payload.modules.agentEventStream.active).toBe(true);
  });

  it("returns 503 when adapter is configured but disconnected", () => {
    noteSocketIoRedisAdapterConnected();
    noteSocketIoRedisAdapterDisconnected();

    const { response, status, json } = buildResponse();
    getRedisHealth({} as Request, response);
    expect(status).toHaveBeenCalledWith(503);
    const payload = json.mock.calls[0]?.[0];
    expect(payload.status).toBe("degraded");
    expect(payload.modules.adapter.active).toBe(false);
    expect(payload.modules.adapter.reason).toBe("disconnected");
  });

  it("returns 503 when REST rate-limit circuit is open", () => {
    noteRestRateLimitRedisConnected();
    noteRestRateLimitRedisCircuitOpened();

    const { response, status, json } = buildResponse();
    getRedisHealth({} as Request, response);
    expect(status).toHaveBeenCalledWith(503);
    const payload = json.mock.calls[0]?.[0];
    expect(payload.modules.restRateLimit.active).toBe(false);
    expect(payload.modules.restRateLimit.reason).toBe("circuit_open");
    expect(payload.modules.restRateLimit.circuitOpen).toBe(true);
  });

  it("treats skipped modules as healthy even when other modules are degraded", () => {
    noteSocketIoRedisAdapterConnected();
    noteSocketIoRedisAdapterDisconnected();
    // Other modules left as skipped (URL not configured)

    const { response, status, json } = buildResponse();
    getRedisHealth({} as Request, response);
    expect(status).toHaveBeenCalledWith(503);
    const payload = json.mock.calls[0]?.[0];
    expect(payload.modules.socketRateLimit.reason).toBe("skipped");
    expect(payload.modules.restRateLimit.reason).toBe("skipped");
    expect(payload.modules.idempotency.reason).toBe("skipped");
    expect(payload.modules.agentEventStream.reason).toBe("skipped");
    expect(payload.modules.adapter.active).toBe(false);
  });
});
