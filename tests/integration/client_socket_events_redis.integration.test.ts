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

const socketIoRedisAdapterUrl = process.env.SOCKET_IO_REDIS_ADAPTER_URL?.trim() ?? "";
const restSocketEventIdempotencyRedisUrl =
  process.env.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL?.trim() ?? "";
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";

const describeIfDistributedRedis =
  socketIoRedisAdapterUrl !== "" && restSocketEventIdempotencyRedisUrl !== "" && databaseUrl !== ""
    ? describe
    : describe.skip;
const describeIfDatabase = databaseUrl !== "" ? describe : describe.skip;

const canReachDatabase = async (): Promise<boolean> => {
  try {
    await prismaClient.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
    return true;
  } catch {
    return false;
  }
};

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

describeIfDistributedRedis("distributed client socket events with Redis", () => {
  let serverA: DistributedHubProcess;
  let serverB: DistributedHubProcess;
  let databaseAvailable = false;
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    databaseAvailable = await canReachDatabase();
    if (!databaseAvailable) {
      return;
    }
    serverA = await spawnDistributedHubProcess({
      socketIoRedisAdapterUrl,
      restSocketEventIdempotencyRedisUrl,
      socketConsumerClientAgentRoomReconcileIntervalMs: 100,
      socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
    });
    serverB = await spawnDistributedHubProcess({
      socketIoRedisAdapterUrl,
      restSocketEventIdempotencyRedisUrl,
      socketConsumerClientAgentRoomReconcileIntervalMs: 100,
      socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
    });
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    if (databaseAvailable) {
      await Promise.all([serverB.close(), serverA.close()]);
    }
  });

  it("delivers across replicas and replays idempotency keys without duplicate fan-out", async () => {
    if (!databaseAvailable) {
      return;
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
    expect(first.body).toMatchObject({
      eventName,
      recipients: 1,
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
      recipients: 1,
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

describeIfDatabase("consumer client-agent room reconciliation", () => {
  let server: DistributedHubProcess;
  let databaseAvailable = false;
  const sockets: ClientSocket[] = [];
  const createdAgentIds = new Set<string>();
  const createdAccessPairs: Array<{ readonly clientId: string; readonly agentId: string }> = [];

  beforeAll(async () => {
    databaseAvailable = await canReachDatabase();
    if (!databaseAvailable) {
      return;
    }
    server = await spawnDistributedHubProcess({
      socketIoRedisAdapterUrl: "",
      restSocketEventIdempotencyRedisUrl: "",
      socketConsumerClientAgentRoomReconcileIntervalMs: 100,
      socketConsumerClientAgentRoomReconcileStartJitterMs: 0,
    });
  });

  afterEach(async () => {
    if (!databaseAvailable) {
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
    if (databaseAvailable) {
      await server.close();
    }
    await prismaClient.$disconnect();
  });

  it("reconciles joins and leaves for approved client-agent rooms after the socket is already connected", async () => {
    if (!databaseAvailable) {
      return;
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
