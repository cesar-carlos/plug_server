import { createServer, type Server as HttpServer } from "node:http";

import { createClient } from "redis";
import type { Server as SocketServer } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetSocketIoRedisAdapterMetricsForTests } from "../../src/application/services/socket_io_redis_adapter_metrics.service";
import type * as SocketIoRedisAdapterModule from "../../src/infrastructure/redis/socket_io_redis_adapter";

import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeSocketIoRedisAdapterInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

const waitUntil = async (
  predicate: () => boolean,
  options?: { readonly timeoutMs?: number; readonly intervalMs?: number },
): Promise<void> => {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
};

const killAdapterRedisClients = async (redisUrl: string): Promise<void> => {
  const admin = createClient({ url: redisUrl });
  admin.on("error", () => {});
  await admin.connect();
  try {
    await admin.sendCommand(["CLIENT", "KILL", "TYPE", "pubsub", "SKIPME", "yes"]);
    await admin.sendCommand(["CLIENT", "KILL", "TYPE", "normal", "SKIPME", "yes"]);
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
};

describe("socket IO Redis adapter integration", () => {
  let adapterModule: typeof SocketIoRedisAdapterModule;
  let httpServer: HttpServer | undefined;
  let io: SocketServer | undefined;
  let redisUrl = "";
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "probe not started",
  };

  beforeAll(async () => {
    const infrastructure = await probeSocketIoRedisAdapterInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }

    redisUrl = infrastructure.redisUrl;
    process.env.SOCKET_IO_REDIS_ADAPTER_URL = redisUrl;
    vi.resetModules();
    resetSocketIoRedisAdapterMetricsForTests();

    const [{ createSocketServer }, adapter] = await Promise.all([
      import("../../src/socket"),
      import("../../src/infrastructure/redis/socket_io_redis_adapter"),
    ]);
    adapterModule = adapter;

    httpServer = createServer();
    io = createSocketServer(httpServer);
    await adapterModule.initSocketIoRedisAdapter(io);

    await new Promise<void>((resolve, reject) => {
      httpServer?.listen(0, "127.0.0.1", () => resolve());
      httpServer?.once("error", reject);
    });
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    if (!infrastructureProbe.ok) {
      return;
    }

    if (io !== undefined) {
      const { closeSocketServer } = await import("../../src/socket");
      await closeSocketServer(io, "integration_test_close");
    }

    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    });

    await adapterModule.closeSocketIoRedisAdapter();
  });

  it("connects pub/sub clients against real Redis", (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);
    expect(adapterModule.isSocketIoRedisAdapterActive()).toBe(true);
  });

  it("falls back to in-memory adapter when Redis clients drop and reconnects", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);

    expect(adapterModule.isSocketIoRedisAdapterActive()).toBe(true);

    await killAdapterRedisClients(redisUrl);

    await waitUntil(() => !adapterModule.isSocketIoRedisAdapterActive(), {
      timeoutMs: 5_000,
    });

    await waitUntil(() => adapterModule.isSocketIoRedisAdapterActive(), {
      timeoutMs: 8_000,
      intervalMs: 100,
    });
  }, 20_000);
});
