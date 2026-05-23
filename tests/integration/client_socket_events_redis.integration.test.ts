import { randomUUID } from "node:crypto";

import request from "supertest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prismaClient } from "../../src/infrastructure/database/prisma/client";
import { buildConsumerClientAgentRoom } from "../../src/presentation/socket/hub/consumer_identity_rooms";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord } from "../../src/shared/utils/rpc_types";
import {
  spawnDistributedHubProcess,
  type DistributedHubProcess,
} from "./helpers/distributed_hub_process";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeDatabaseInfrastructure,
  probeDistributedRedisInfrastructure,
  type DistributedRedisInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

const connectConsumer = (baseUrl: string, token: string): Promise<ClientSocket> =>
  new Promise<ClientSocket>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
    });
    socket.on("connection:ready", (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        reject(new Error(`Failed to decode connection:ready: ${decoded.error.message}`));
        return;
      }
      resolve(socket);
    });
    socket.on("connect_error", (error) => reject(error));
  });

const waitForEvent = <T>(socket: ClientSocket, eventName: string, timeoutMs = 6_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const onEvent = (payload: T): void => {
      clearTimeout(timeout);
      socket.off(eventName, onEvent);
      resolve(payload);
    };

    socket.on(eventName, onEvent);
  });

const waitForNoEvent = async (
  socket: ClientSocket,
  eventName: string,
  timeoutMs = 350,
): Promise<void> => {
  await expect(waitForEvent(socket, eventName, timeoutMs)).rejects.toThrow(/Timed out/);
};

const subscribe = async (
  socket: ClientSocket,
  eventName: string,
  requestId: string,
): Promise<void> => {
  const ackPromise = waitForEvent<{
    success: boolean;
    requestId: string;
    data?: { eventName: string; subscribed: boolean };
  }>(socket, socketEvents.socketEventSubscribed);
  socket.emit(socketEvents.socketEventSubscribe, { requestId, eventName });
  await expect(ackPromise).resolves.toMatchObject({
    success: true,
    requestId,
    data: expect.objectContaining({ eventName, subscribed: true }),
  });
};

const decodeCustomEventFrame = (rawFrame: unknown): Record<string, unknown> => {
  const decoded = decodePayloadFrame(rawFrame);
  if (!decoded.ok || !isRecord(decoded.value.data)) {
    throw new Error("Invalid custom event PayloadFrame");
  }
  return decoded.value.data;
};

describe("distributed client socket events with Redis", () => {
  let serverA: DistributedHubProcess | undefined;
  let serverB: DistributedHubProcess | undefined;
  let infrastructure: DistributedRedisInfrastructure | undefined;
  let bootstrapProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "distributed hub bootstrap not started",
  };
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    infrastructure = await probeDistributedRedisInfrastructure();
    if (!infrastructure.probe.ok) {
      bootstrapProbe = infrastructure.probe;
      return;
    }

    try {
      serverA = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
        socketConsumerClientAgentRoomReconcileIntervalMs: 100,
        socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
      });
      serverB = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
        socketConsumerClientAgentRoomReconcileIntervalMs: 100,
        socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
      });
      bootstrapProbe = { ok: true };
    } catch (error) {
      bootstrapProbe = {
        ok: false,
        reason:
          error instanceof Error
            ? `distributed hub bootstrap failed: ${error.message}`
            : "distributed hub bootstrap failed",
      };
    }
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    if (bootstrapProbe.ok && serverA !== undefined && serverB !== undefined) {
      await Promise.all([serverB.close(), serverA.close()]);
    }
  });

  it("delivers across replicas and replays idempotency keys without duplicate fan-out", async (ctx) => {
    assertInfrastructureOrSkip(
      ctx,
      infrastructure?.probe ?? { ok: false, reason: "probe missing" },
    );
    assertInfrastructureOrSkip(ctx, bootstrapProbe);
    if (serverA === undefined || serverB === undefined) {
      throw new Error("distributed hub servers were not started");
    }

    const session = await registerOwnerAndClientSession(serverA.baseUrl, {
      suffix: `redis-fanout-${Date.now()}`,
    });
    const eventName = "client:custom.redis.broadcast";
    const subscriber = await connectConsumer(serverB.baseUrl, session.client.accessToken);
    sockets.push(subscriber);
    await subscribe(subscriber, eventName, "sub-redis-fanout");

    const firstEvent = waitForEvent<unknown>(subscriber, eventName);
    const first = await request(serverA.baseUrl)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "redis-idem-key-1")
      .send({ eventName, payload: { replica: "a", count: 1 } });

    expect(first.status).toBe(202);
    // Default REST_SOCKET_EVENT_MAX_RECIPIENTS=0 uses local_only counting on the publishing
    // replica; subscriber is on serverB so recipients is 0 even though Redis still delivers.
    expect(first.body).toMatchObject({
      eventName,
      recipients: 0,
      idempotentReplay: false,
    });
    expect(decodeCustomEventFrame(await firstEvent).payload).toEqual({ replica: "a", count: 1 });

    const noDuplicate = waitForNoEvent(subscriber, eventName);
    const replay = await request(serverB.baseUrl)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "redis-idem-key-1")
      .send({ eventName, payload: { replica: "a", count: 1 } });

    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      eventId: first.body.eventId,
      eventName,
      recipients: 0,
      idempotencyKey: "redis-idem-key-1",
      idempotentReplay: true,
    });
    await noDuplicate;

    const conflict = await request(serverB.baseUrl)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "redis-idem-key-1")
      .send({ eventName, payload: { replica: "b", count: 2 } });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("consumer client-agent room reconciliation", () => {
  let server: DistributedHubProcess | undefined;
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "database probe not started",
  };
  let bootstrapProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "reconciliation hub bootstrap not started",
  };
  const sockets: ClientSocket[] = [];
  const createdAgentIds = new Set<string>();
  const createdAccessPairs: Array<{ readonly clientId: string; readonly agentId: string }> = [];

  beforeAll(async () => {
    const infrastructure = await probeDatabaseInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }

    try {
      server = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: "",
        restSocketEventIdempotencyRedisUrl: "",
        socketConsumerClientAgentRoomReconcileIntervalMs: 100,
        socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
      });
      bootstrapProbe = { ok: true };
    } catch (error) {
      bootstrapProbe = {
        ok: false,
        reason:
          error instanceof Error
            ? `reconciliation hub bootstrap failed: ${error.message}`
            : "reconciliation hub bootstrap failed",
      };
    }
  }, integrationHookTimeoutMs);

  afterEach(async () => {
    if (!bootstrapProbe.ok || server === undefined) {
      return;
    }
    for (const { clientId, agentId } of createdAccessPairs.splice(0)) {
      await prismaClient.clientAgentAccess.deleteMany({
        where: { clientId, agentId },
      });
    }
    if (createdAgentIds.size > 0) {
      await prismaClient.agent.deleteMany({
        where: { agentId: { in: Array.from(createdAgentIds) } },
      });
      createdAgentIds.clear();
    }
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    if (bootstrapProbe.ok && server !== undefined) {
      await server.close();
    }
    await prismaClient.$disconnect();
  });

  it("reconciles joins and leaves for approved client-agent rooms after the socket is already connected", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);
    assertInfrastructureOrSkip(ctx, bootstrapProbe);
    if (server === undefined) {
      throw new Error("reconciliation hub server was not started");
    }

    const session = await registerOwnerAndClientSession(server.baseUrl, {
      suffix: `room-reconcile-${Date.now()}`,
    });
    const socket = await connectConsumer(server.baseUrl, session.client.accessToken);
    sockets.push(socket);

    const agentId = randomUUID();
    const room = buildConsumerClientAgentRoom({
      clientId: session.client.clientId,
      agentId,
    });

    await prismaClient.agent.create({
      data: {
        agentId,
        name: "Reconcile Agent",
        status: "active",
      },
    });
    createdAgentIds.add(agentId);

    expect(await server.getConsumerRoomCount(room)).toBe(0);

    await prismaClient.clientAgentAccess.create({
      data: {
        clientId: session.client.clientId,
        agentId,
        approvedAt: new Date(),
      },
    });
    createdAccessPairs.push({ clientId: session.client.clientId, agentId });

    await expect
      .poll(() => server.getConsumerRoomCount(room), {
        timeout: 5_000,
        interval: 100,
      })
      .toBe(1);

    await prismaClient.clientAgentAccess.deleteMany({
      where: {
        clientId: session.client.clientId,
        agentId,
      },
    });
    createdAccessPairs.length = 0;

    await expect
      .poll(() => server.getConsumerRoomCount(room), {
        timeout: 5_000,
        interval: 100,
      })
      .toBe(0);
  });
});

describe("consumer client-agent room reconciliation across Redis replicas", () => {
  let serverA: DistributedHubProcess | undefined;
  let serverB: DistributedHubProcess | undefined;
  let infrastructure: DistributedRedisInfrastructure | undefined;
  let bootstrapProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "cross-replica reconcile bootstrap not started",
  };
  const sockets: ClientSocket[] = [];
  const createdAgentIds = new Set<string>();

  beforeAll(async () => {
    infrastructure = await probeDistributedRedisInfrastructure();
    if (!infrastructure.probe.ok) {
      bootstrapProbe = infrastructure.probe;
      return;
    }

    try {
      serverA = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
        socketConsumerClientAgentRoomReconcileIntervalMs: 100,
        socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
      });
      serverB = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
        socketConsumerClientAgentRoomReconcileIntervalMs: 100,
        socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
      });
      bootstrapProbe = { ok: true };
    } catch (error) {
      bootstrapProbe = {
        ok: false,
        reason:
          error instanceof Error
            ? `cross-replica reconcile bootstrap failed: ${error.message}`
            : "cross-replica reconcile bootstrap failed",
      };
    }
  }, integrationHookTimeoutMs);

  afterEach(async () => {
    if (createdAgentIds.size === 0) {
      return;
    }
    await prismaClient.clientAgentAccess.deleteMany({
      where: { agentId: { in: Array.from(createdAgentIds) } },
    });
    await prismaClient.clientAgentAccessRequest.deleteMany({
      where: { agentId: { in: Array.from(createdAgentIds) } },
    });
    await prismaClient.agentIdentity.deleteMany({
      where: { agentId: { in: Array.from(createdAgentIds) } },
    });
    await prismaClient.agent.deleteMany({
      where: { agentId: { in: Array.from(createdAgentIds) } },
    });
    createdAgentIds.clear();
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    if (bootstrapProbe.ok && serverA !== undefined && serverB !== undefined) {
      await Promise.all([serverB.close(), serverA.close()]);
    }
    await prismaClient.$disconnect();
  });

  it("should join consumer:client-agent rooms on a remote replica after grantClientAccess", async (ctx) => {
    assertInfrastructureOrSkip(
      ctx,
      infrastructure?.probe ?? { ok: false, reason: "probe missing" },
    );
    assertInfrastructureOrSkip(ctx, bootstrapProbe);
    if (serverA === undefined || serverB === undefined) {
      throw new Error("cross-replica reconcile servers were not started");
    }

    const session = await registerOwnerAndClientSession(serverA.baseUrl, {
      suffix: `cross-replica-grant-${Date.now()}`,
    });
    const agentId = randomUUID();
    await prismaClient.agent.create({
      data: {
        agentId,
        name: "Cross Replica Agent",
        status: "active",
      },
    });
    await prismaClient.agentIdentity.create({
      data: {
        agentId,
        userId: session.owner.userId,
      },
    });
    createdAgentIds.add(agentId);

    const requestAccess = await request(serverA.baseUrl)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({ agentIds: [agentId] });
    expect(requestAccess.status).toBe(200);

    const ownerRequests = await request(serverA.baseUrl)
      .get("/api/v1/me/client-access-requests")
      .set("Authorization", `Bearer ${session.owner.accessToken}`)
      .query({ status: "pending", agentId });
    expect(ownerRequests.status).toBe(200);
    const requestId = ownerRequests.body.requests[0]?.id as string;
    expect(typeof requestId).toBe("string");

    const socket = await connectConsumer(serverB.baseUrl, session.client.accessToken);
    sockets.push(socket);

    const room = buildConsumerClientAgentRoom({
      clientId: session.client.clientId,
      agentId,
    });
    expect(await serverB.getConsumerRoomCount(room)).toBe(0);

    const approve = await request(serverA.baseUrl)
      .post(`/api/v1/me/client-access-requests/${requestId}/approve`)
      .set("Authorization", `Bearer ${session.owner.accessToken}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.approved).toBe(true);

    await expect
      .poll(() => serverB.getConsumerRoomCount(room), {
        timeout: 5_000,
        interval: 100,
      })
      .toBe(1);
  });
});

describe("REST socket event distributed count circuit", () => {
  let server: DistributedHubProcess | undefined;
  let infrastructure: DistributedRedisInfrastructure | undefined;
  let bootstrapProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "distributed count circuit bootstrap not started",
  };
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    infrastructure = await probeDistributedRedisInfrastructure();
    if (!infrastructure.probe.ok) {
      bootstrapProbe = infrastructure.probe;
      return;
    }

    try {
      server = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
        restSocketEventMaxRecipients: 256,
        restSocketEventDistributedCountFailureThreshold: 2,
        restSocketEventDistributedCountFailureOpenMs: 30_000,
        restSocketEventBestEffortLocalMaxRecipients: 256,
      });
      bootstrapProbe = { ok: true };
    } catch (error) {
      bootstrapProbe = {
        ok: false,
        reason:
          error instanceof Error
            ? `distributed count circuit bootstrap failed: ${error.message}`
            : "distributed count circuit bootstrap failed",
      };
    }
  }, integrationHookTimeoutMs);

  afterEach(async () => {
    if (server !== undefined) {
      await server.setFetchSocketsFailure(false);
    }
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    if (bootstrapProbe.ok && server !== undefined) {
      await server.close();
    }
  });

  it("should publish in best-effort mode when fetchSockets fails and return 503 once the circuit opens", async (ctx) => {
    assertInfrastructureOrSkip(
      ctx,
      infrastructure?.probe ?? { ok: false, reason: "probe missing" },
    );
    assertInfrastructureOrSkip(ctx, bootstrapProbe);
    if (server === undefined) {
      throw new Error("distributed count circuit server was not started");
    }

    const session = await registerOwnerAndClientSession(server.baseUrl, {
      suffix: `distributed-count-circuit-${Date.now()}`,
    });
    const eventName = "client:custom.redis.distributed-count";
    const subscriber = await connectConsumer(server.baseUrl, session.client.accessToken);
    sockets.push(subscriber);
    await subscribe(subscriber, eventName, "sub-distributed-count-circuit");

    await server.setFetchSocketsFailure(true);

    const firstEvent = waitForEvent<unknown>(subscriber, eventName);
    const first = await request(server.baseUrl)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "distributed-count-best-effort-1")
      .send({ eventName, payload: { phase: "best-effort", attempt: 1 } });

    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      eventName,
      recipients: 1,
      idempotentReplay: false,
    });
    expect(decodeCustomEventFrame(await firstEvent).payload).toEqual({
      phase: "best-effort",
      attempt: 1,
    });

    const circuitOpen = await request(server.baseUrl)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "distributed-count-circuit-open")
      .send({ eventName, payload: { phase: "circuit-open", attempt: 2 } });

    expect(circuitOpen.status).toBe(503);
    expect(circuitOpen.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(circuitOpen.body.details?.retry_after_ms).toEqual(expect.any(Number));
  });
});
