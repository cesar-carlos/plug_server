import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { registerHttpRateLimits } from "../../src/presentation/http/middlewares/rate_limit.middleware";
import { prismaClient } from "../../src/infrastructure/database/prisma/client";
import { signAccessToken } from "../../src/shared/utils/jwt";
import { agentRegistry } from "../../src/presentation/socket/hub/registries/agent_registry";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { percentile } from "../../src/shared/utils/percentile";
import { isRecord } from "../../src/shared/utils/rpc_types";
import { getAgentHubPresenceRedisMetricsSnapshot } from "../../src/application/services/agent_hub_presence_redis_metrics.service";
import { getClientSocketEventIdempotencyRedisMetricsSnapshot } from "../../src/application/services/client_socket_event_idempotency_redis_metrics.service";
import {
  setClientSocketEventPublishIdempotencyEntry,
  resetClientSocketEventPublishIdempotencyStore,
} from "../../src/application/services/client_socket_event_idempotency_store";
import {
  initAgentHubPresenceRedis,
  closeAgentHubPresenceRedis,
  getAgentHubPresencePort,
} from "../../src/infrastructure/redis/presence/agent_hub_presence_redis";
import {
  initClientSocketEventPublishIdempotencyRedis,
  closeClientSocketEventPublishIdempotencyRedis,
} from "../../src/infrastructure/redis/idempotency/client_socket_event_publish_idempotency_redis";
import {
  registerSocketBridgeServer,
  registerAgentBridgeSocket,
  handleAgentRpcResponse,
  resetSocketBridgeState,
  stopRelayMetricsLogger,
} from "../../src/presentation/socket/hub/relay/rpc_bridge";

interface ScenarioResult {
  readonly name: string;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly throughputPerSec: number;
  readonly heapGrowthBytes: number;
  readonly retainedHeapGrowthBytes: number;
  readonly heapStartBytes: number;
  readonly heapAfterGcBytes: number;
  readonly repetitions?: readonly ScenarioResult[];
  readonly rssPeakBytes: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly eventLoopDelayP95Ms: number;
  readonly sqlQueries: number;
  readonly redisCommands: number;
  readonly peakActiveRpcs: number;
  readonly errors: number;
  readonly responseDigest: string;
  readonly refreshWaitMs: number;
  readonly refreshWaitingPeak: number;
  readonly timeouts: number;
}

const median = (values: readonly number[]): number => percentile(values, 50);
const redisCount = (): number =>
  getAgentHubPresenceRedisMetricsSnapshot().commandLatency.count +
  Object.values(getClientSocketEventIdempotencyRedisMetricsSnapshot().latency).reduce(
    (sum, value) => sum + value.count,
    0,
  );

export const runRestApiBench = async (): Promise<{
  harnessVersion: number;
  config: {
    warmup: number;
    iterations: number;
    repeats: number;
    agents: number;
    registry: number;
    refreshConcurrency: string;
    scenarioFilter: string;
  };
  configFingerprint: string;
  nodeVersion: string;
  platform: string;
  scenarios: ScenarioResult[];
  versions: { prisma: string; postgres: string; redis: string };
}> => {
  if (typeof globalThis.gc !== "function")
    throw new Error("REST benchmark requires explicit GC in the test worker");
  const config = {
    warmup: Number(process.env.REST_BENCH_WARMUP ?? 16),
    iterations: Number(process.env.REST_BENCH_ITERATIONS ?? 64),
    repeats: Number(process.env.REST_BENCH_REPEATS ?? 9),
    agents: 1000,
    registry: 10000,
    refreshConcurrency: process.env.REST_AGENT_PROFILE_REFRESH_CONCURRENCY ?? "4",
    scenarioFilter: process.env.REST_BENCH_SCENARIOS ?? "all",
  };
  const requireModule = createRequire(__filename);
  const pg = requireModule("pg") as {
    Client: { prototype: { query: (...args: unknown[]) => unknown } };
  };
  const originalQuery = pg.Client.prototype.query;
  let sqlQueries = 0;
  pg.Client.prototype.query = function (...args: unknown[]): unknown {
    sqlQueries++;
    return Reflect.apply(originalQuery, this, args);
  };
  const ownerId = randomUUID(),
    smallOwnerId = randomUUID(),
    clientId = randomUUID(),
    remoteClientId = randomUUID();
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const agentIds = Array.from({ length: config.agents }, (_, index) =>
    createHash("md5")
      .update(`rest-bench-agent-${index}`)
      .digest("hex")
      .replace(/^(........)(....).(...).(...)(............)$/, "$1-$2-4$3-8$4-$5"),
  );
  const adminToken = signAccessToken({
    sub: ownerId,
    role: "admin",
    tokenType: "access",
    credentials_version: timestamp.getTime(),
  });
  const ownerToken = signAccessToken({
    sub: ownerId,
    role: "user",
    tokenType: "access",
    credentials_version: timestamp.getTime(),
  });
  const smallToken = signAccessToken({
    sub: smallOwnerId,
    role: "user",
    tokenType: "access",
    credentials_version: timestamp.getTime(),
  });
  const clientToken = signAccessToken({
    sub: clientId,
    principal_type: "client",
    role: "client",
    tokenType: "access",
    credentials_version: timestamp.getTime(),
  });
  const remoteToken = signAccessToken({
    sub: remoteClientId,
    principal_type: "client",
    role: "client",
    tokenType: "access",
    credentials_version: timestamp.getTime(),
  });
  registerHttpRateLimits();
  const { createApp } = await import("../../src/app");
  const { container } = await import("../../src/shared/di/container");
  const queryService = container.clientAgentAccessQueryService;
  const readRefreshMetrics = (): { waitSumMs: number; waiting: number } => {
    const read = Reflect.get(queryService, "getRefreshMetrics");
    return typeof read === "function"
      ? (Reflect.apply(read, queryService, []) as { waitSumMs: number; waiting: number })
      : { waitSumMs: 0, waiting: 0 };
  };
  const http = createServer(createApp());
  const hub = new Server(http, { transports: ["websocket"], perMessageDeflate: false });
  const namespace = hub.of("/agents");
  registerSocketBridgeServer(namespace);
  let activeRpcs = 0,
    peakActiveRpcs = 0;
  namespace.on("connection", (socket) => {
    const agentId = String(socket.handshake.auth.agentId);
    registerAgentBridgeSocket(namespace, socket.id);
    agentRegistry.upsert({ agentId, socketId: socket.id, userId: ownerId, capabilities: {} });
    agentRegistry.touchLiveness(agentId, { markProtocolReady: true, socketId: socket.id });
    socket.on("rpc:response", (raw: unknown) => handleAgentRpcResponse(socket.id, raw));
  });
  const sockets: Socket[] = [];
  const versions = {
    prisma: String((requireModule("@prisma/client/package.json") as { version: string }).version),
    postgres: "",
    redis: "",
  };
  try {
    const rows = await prismaClient.$queryRaw<
      Array<{ server_version: string }>
    >`SHOW server_version`;
    versions.postgres = rows[0]!.server_version;
    const { createClient } = await import("redis");
    const versionClient = createClient({ url: process.env.AGENT_HUB_PRESENCE_REDIS_URL });
    await versionClient.connect();
    try {
      versions.redis =
        (await versionClient.info("server")).match(/redis_version:([^\r\n]+)/)?.[1] ?? "unknown";
    } finally {
      await versionClient.quit();
    }
    await prismaClient.user.createMany({
      data: [ownerId, smallOwnerId].map((id, index) => ({
        id,
        email: `rest-bench-${index}-${id}@test.invalid`,
        passwordHash: "unused-benchmark-hash",
        status: "active" as const,
        credentialsUpdatedAt: timestamp,
        createdAt: timestamp,
      })),
    });
    await prismaClient.agent.createMany({
      data: agentIds.map((agentId, index) => ({
        agentId,
        name: `Bench ${String(index).padStart(5, "0")}`,
        profileUpdatedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    });
    await prismaClient.agentIdentity.createMany({
      data: agentIds.map((agentId, index) => ({
        agentId,
        userId: index < 3 ? smallOwnerId : ownerId,
      })),
    });
    await prismaClient.client.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: index === 0 ? clientId : index === 1 ? remoteClientId : randomUUID(),
        userId: ownerId,
        email: `rest-bench-client-${index}-${ownerId}@test.invalid`,
        passwordHash: "unused-benchmark-hash",
        name: `Client ${index}`,
        lastName: "Bench",
        status: "active" as const,
        credentialsUpdatedAt: timestamp,
        createdAt: new Date(timestamp.getTime() + index),
      })),
    });
    await prismaClient.clientAgentAccess.createMany({
      data: [
        ...agentIds.slice(0, 4).map((agentId) => ({ clientId, agentId })),
        ...agentIds.slice(4, 24).map((agentId) => ({ clientId: remoteClientId, agentId })),
      ],
    });
    await initAgentHubPresenceRedis();
    if (!getAgentHubPresencePort().isEnabled)
      throw new Error("REST benchmark requires isolated Redis presence");
    await initClientSocketEventPublishIdempotencyRedis();
    await Promise.all(
      agentIds.slice(4, 24).map((agentId) =>
        getAgentHubPresencePort().upsert(agentId, {
          hubInstanceId: "bench-remote",
          socketId: `remote-${agentId}`,
          connectedAtMs: timestamp.getTime(),
        }),
      ),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing benchmark port");
    const url = `http://127.0.0.1:${address.port}`;
    for (const agentId of agentIds.slice(0, 4)) {
      const socket = io(`${url}/agents`, {
        auth: { agentId },
        transports: ["websocket"],
        reconnection: false,
      });
      sockets.push(socket);
      socket.on("rpc:request", (raw: unknown) => {
        const decoded = decodePayloadFrame(raw);
        if (!decoded.ok || !isRecord(decoded.value.data)) throw new Error("Invalid simulated RPC");
        const request = decoded.value.data;
        activeRpcs++;
        peakActiveRpcs = Math.max(peakActiveRpcs, activeRpcs);
        void delay(2).then(() => {
          activeRpcs--;
          socket.emit(
            "rpc:response",
            encodePayloadFrame(
              {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  agent_id: agentId,
                  profile: { name: `Bench ${String(agentIds.indexOf(agentId)).padStart(5, "0")}` },
                  profile_version: 0,
                  updated_at: timestamp.toISOString(),
                },
              },
              { requestId: String(request.id) },
            ),
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
    }
    for (let index = 0; index < config.registry - 4; index++)
      agentRegistry.upsert({
        agentId: `registry-${index}`,
        socketId: `registry-socket-${index}`,
        userId: null,
        capabilities: {},
      });
    for (let index = 0; index < 9900; index++)
      setClientSocketEventPublishIdempotencyEntry(clientId, `seed-${index}`, {
        fingerprint: "seed",
        response: {
          success: true,
          eventId: "seed",
          eventName: "client:custom.bench",
          recipients: 0,
        },
      });
    const request = async (
      route: string,
      token: string,
      init?: RequestInit,
    ): Promise<{ status: number; data: unknown; etag: string | null }> => {
      const response = await fetch(`${url}${route}`, {
        signal: AbortSignal.timeout(30000),
        ...init,
        headers: { Authorization: `Bearer ${token}`, "x-no-compression": "1", ...init?.headers },
      });
      return {
        status: response.status,
        data: response.status === 304 ? null : await response.json(),
        etag: response.headers.get("etag"),
      };
    };
    const etag = (await request("/api/v1/agents/catalog?pageSize=20", adminToken)).etag!;
    let publishIndex = 0;
    const scenarios: Array<{ name: string; expectedStatus: number; run: () => Promise<unknown> }> =
      [
        {
          name: "catalog_small",
          expectedStatus: 200,
          run: () => request("/api/v1/agents/catalog?pageSize=20", smallToken),
        },
        {
          name: "catalog_many",
          expectedStatus: 200,
          run: () => request("/api/v1/agents/catalog?pageSize=20", ownerToken),
        },
        {
          name: "managed_clients",
          expectedStatus: 200,
          run: () => request("/api/v1/me/clients?pageSize=20", ownerToken),
        },
        {
          name: "registry_page",
          expectedStatus: 200,
          run: () => request("/api/v1/agents?page=1&pageSize=20", adminToken),
        },
        {
          name: "etag_poll",
          expectedStatus: 304,
          run: () =>
            request("/api/v1/agents/catalog?pageSize=20", adminToken, {
              headers: { "If-None-Match": etag },
            }),
        },
        {
          name: "remote_presence",
          expectedStatus: 200,
          run: () => request("/api/v1/client/me/agents?pageSize=20", remoteToken),
        },
        {
          name: "refresh_mixed",
          expectedStatus: 200,
          run: () =>
            Promise.all([
              request("/api/v1/client/me/agents?refresh=true", clientToken),
              request(`/api/v1/client/me/agents/${agentIds[0]}`, clientToken),
            ]),
        },
        {
          name: "refresh_saturated",
          expectedStatus: 200,
          run: async () =>
            Promise.all([
              request("/api/v1/client/me/agents?refresh=true", clientToken),
              ...Array.from({ length: 8 }, (_, i) =>
                request(`/api/v1/client/me/agents/${agentIds[i % 4]}`, clientToken),
              ),
            ]),
        },
        {
          name: "idempotency_capacity",
          expectedStatus: 202,
          run: () =>
            request("/api/v1/client/me/socket-events", clientToken, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": `bench-${publishIndex++}`,
              },
              body: JSON.stringify({ eventName: "client:custom.bench", payload: { value: 1 } }),
            }),
        },
      ];
    const normalize = (value: unknown): unknown => {
      if (typeof value === "string")
        return value
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>");
      if (Array.isArray(value)) return value.map(normalize);
      if (isRecord(value))
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "etag")
            .map(([key, item]) => [key, normalize(item)]),
        );
      return value;
    };
    const results: ScenarioResult[] = [];
    for (const scenario of scenarios.filter(
      (scenario) =>
        config.scenarioFilter === "all" || config.scenarioFilter.split(",").includes(scenario.name),
    )) {
      for (let index = 0; index < config.warmup; index++) await scenario.run();
      const repetitions: ScenarioResult[] = [];
      for (let repeat = 0; repeat < config.repeats; repeat++) {
        globalThis.gc?.();
        const heapStart = process.memoryUsage().heapUsed;
        let heapPeak = heapStart,
          rssPeak = process.memoryUsage().rss,
          errors = 0,
          timeouts = 0,
          refreshWaitingPeak = 0;
        const refreshStart = readRefreshMetrics().waitSumMs;
        const waitingSampler = setInterval(() => {
          refreshWaitingPeak = Math.max(refreshWaitingPeak, readRefreshMetrics().waiting);
        }, 1);
        const cpuStart = process.cpuUsage(),
          sqlStart = sqlQueries,
          redisStart = redisCount();
        peakActiveRpcs = 0;
        const loop = monitorEventLoopDelay({ resolution: 10 });
        loop.enable();
        const samples: number[] = [];
        let responseShape: unknown;
        const started = performance.now();
        for (let iteration = 0; iteration < config.iterations; iteration++) {
          const t0 = performance.now(),
            response = await scenario.run();
          samples.push(performance.now() - t0);
          const responses = Array.isArray(response) ? response : [response];
          for (const entry of responses)
            if (!isRecord(entry) || entry.status !== scenario.expectedStatus) errors++;
          responseShape = normalize(responses);
          for (const entry of responses)
            if (
              isRecord(entry) &&
              isRecord(entry.data) &&
              typeof entry.data.code === "string" &&
              /TIMEOUT/.test(entry.data.code)
            )
              timeouts++;
          const memory = process.memoryUsage();
          heapPeak = Math.max(heapPeak, memory.heapUsed);
          rssPeak = Math.max(rssPeak, memory.rss);
        }
        const elapsed = performance.now() - started,
          cpu = process.cpuUsage(cpuStart);
        loop.disable();
        clearInterval(waitingSampler);
        await delay(0);
        globalThis.gc?.();
        const heapAfterGc = process.memoryUsage().heapUsed;
        repetitions.push({
          name: scenario.name,
          p50Ms: percentile(samples, 50),
          p95Ms: percentile(samples, 95),
          p99Ms: percentile(samples, 99),
          throughputPerSec: (config.iterations * 1000) / elapsed,
          heapGrowthBytes: heapPeak - heapStart,
          retainedHeapGrowthBytes: Math.max(0, heapAfterGc - heapStart),
          heapStartBytes: heapStart,
          heapAfterGcBytes: heapAfterGc,
          rssPeakBytes: rssPeak,
          cpuUserMs: cpu.user / 1000,
          cpuSystemMs: cpu.system / 1000,
          eventLoopDelayP95Ms: loop.percentile(95) / 1e6,
          sqlQueries: sqlQueries - sqlStart,
          redisCommands: redisCount() - redisStart,
          peakActiveRpcs,
          errors,
          refreshWaitMs: readRefreshMetrics().waitSumMs - refreshStart,
          refreshWaitingPeak,
          timeouts,
          responseDigest: createHash("sha256").update(JSON.stringify(responseShape)).digest("hex"),
        });
      }
      const first = repetitions[0]!;
      results.push({
        ...first,
        repetitions,
        retainedHeapGrowthBytes: median(repetitions.map((r) => r.retainedHeapGrowthBytes)),
        p50Ms: median(repetitions.map((r) => r.p50Ms)),
        p95Ms: median(repetitions.map((r) => r.p95Ms)),
        p99Ms: median(repetitions.map((r) => r.p99Ms)),
        throughputPerSec: median(repetitions.map((r) => r.throughputPerSec)),
        heapGrowthBytes: median(repetitions.map((r) => r.heapGrowthBytes)),
        cpuUserMs: median(repetitions.map((r) => r.cpuUserMs)),
        cpuSystemMs: median(repetitions.map((r) => r.cpuSystemMs)),
        refreshWaitMs: median(repetitions.map((r) => r.refreshWaitMs)),
        refreshWaitingPeak: Math.max(...repetitions.map((r) => r.refreshWaitingPeak)),
        timeouts: repetitions.reduce((sum, r) => sum + r.timeouts, 0),
        sqlQueries: median(repetitions.map((r) => r.sqlQueries)),
        redisCommands: median(repetitions.map((r) => r.redisCommands)),
        eventLoopDelayP95Ms: median(repetitions.map((r) => r.eventLoopDelayP95Ms)),
        rssPeakBytes: Math.max(...repetitions.map((r) => r.rssPeakBytes)),
        errors: repetitions.reduce((sum, r) => sum + r.errors, 0),
        peakActiveRpcs: Math.max(...repetitions.map((r) => r.peakActiveRpcs)),
      });
    }
    return {
      harnessVersion: 3,
      versions,
      config,
      configFingerprint: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      nodeVersion: process.version,
      platform: process.platform,
      scenarios: results,
    };
  } finally {
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    const close = Reflect.get(queryService, "close");
    if (typeof close === "function") await Reflect.apply(close, queryService, []);
    await Promise.all(
      agentIds
        .slice(4, 24)
        .map((id) => getAgentHubPresencePort().removeIfHubInstanceMatches(id, "bench-remote")),
    );
    agentRegistry.clear();
    resetSocketBridgeState();
    stopRelayMetricsLogger();
    resetClientSocketEventPublishIdempotencyStore();
    await closeAgentHubPresenceRedis();
    await closeClientSocketEventPublishIdempotencyRedis();
    await prismaClient.user.deleteMany({ where: { id: { in: [ownerId, smallOwnerId] } } });
    await prismaClient.agent.deleteMany({ where: { agentId: { in: agentIds } } });
    pg.Client.prototype.query = originalQuery;
    await prismaClient.$disconnect();
  }
};
