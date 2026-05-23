import { randomUUID } from "node:crypto";

import request from "supertest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prismaClient } from "../../src/infrastructure/database/prisma/client";
import { env } from "../../src/shared/config/env";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../src/shared/utils/rpc_types";
import {
  spawnDistributedHubProcess,
  type DistributedHubProcess,
} from "./helpers/distributed_hub_process";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeDistributedRedisInfrastructure,
  type DistributedRedisInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

/**
 * Relay bridge state (conversationRegistry, agentRegistry, pending RPC routes) is
 * process-local — see docs/socket_relay_protocol.md § "Process-local". The
 * Socket.IO Redis adapter only synchronizes rooms/broadcast (e.g. client:custom.*),
 * not relay dispatch. These tests document expected multi-replica behaviour:
 * cross-replica consumer↔agent fails; same-hub (sticky) succeeds with Redis enabled.
 */

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

const connectAgent = (baseUrl: string, token: string): Promise<ClientSocket> =>
  new Promise<ClientSocket>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agents`, {
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

const waitForEvent = <T>(socket: ClientSocket, eventName: string, timeoutMs = 8_000): Promise<T> =>
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

const registerAgentAndWaitReady = async (
  socket: ClientSocket,
  agentId: string,
): Promise<void> => {
  const capabilitiesPromise = waitForEvent<unknown>(socket, "agent:capabilities");
  socket.emit(
    "agent:register",
    encodePayloadFrame({
      agentId,
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
      timestamp: new Date().toISOString(),
    }),
  );
  await capabilitiesPromise;
  if (env.socketAgentProtocolReadyGraceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.socketAgentProtocolReadyGraceMs));
  }
};

interface RelayAgentFixture {
  readonly agentId: string;
  readonly agentAccessToken: string;
  readonly clientId: string;
  readonly clientAccessToken: string;
}

const seedRelayAgentFixture = async (
  hubBaseUrl: string,
  suffix: string,
): Promise<RelayAgentFixture> => {
  const session = await registerOwnerAndClientSession(hubBaseUrl, { suffix });
  const agentId = randomUUID();

  await prismaClient.agent.create({
    data: {
      agentId,
      name: `Relay Multi-Replica Agent ${suffix}`,
      status: "active",
    },
  });
  await prismaClient.agentIdentity.create({
    data: {
      agentId,
      userId: session.owner.userId,
    },
  });

  await prismaClient.clientAgentAccess.create({
    data: {
      clientId: session.client.clientId,
      agentId,
      approvedAt: new Date(),
    },
  });

  const agentLoginRes = await request(hubBaseUrl).post("/api/v1/auth/agent-login").send({
    email: session.owner.email,
    password: session.owner.password,
    agentId,
  });
  if (agentLoginRes.status !== 200) {
    throw new Error(`agent-login failed: ${agentLoginRes.status} ${agentLoginRes.text}`);
  }

  return {
    agentId,
    agentAccessToken: agentLoginRes.body.accessToken as string,
    clientId: session.client.clientId,
    clientAccessToken: session.client.accessToken,
  };
};

describe("relay multi-replica with Redis adapter", () => {
  let serverA: DistributedHubProcess | undefined;
  let serverB: DistributedHubProcess | undefined;
  let infrastructure: DistributedRedisInfrastructure | undefined;
  let bootstrapProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "distributed hub bootstrap not started",
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
      });
      serverB = await spawnDistributedHubProcess({
        socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
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

  afterEach(async () => {
    if (createdAgentIds.size === 0) {
      return;
    }
    await prismaClient.clientAgentAccess.deleteMany({
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

  it("should reject relay conversation start when agent is registered only on another hub", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructure?.probe ?? { ok: false, reason: "probe missing" });
    assertInfrastructureOrSkip(ctx, bootstrapProbe);
    if (!env.socketConsumerRoles.includes("client")) {
      ctx.skip("SOCKET_CONSUMER_ROLES does not include client");
    }
    if (serverA === undefined || serverB === undefined) {
      throw new Error("distributed hub servers were not started");
    }

    const suffix = `relay-cross-${Date.now()}`;
    const fixture = await seedRelayAgentFixture(serverA.baseUrl, suffix);
    createdAgentIds.add(fixture.agentId);

    const agentSocket = await connectAgent(serverB.baseUrl, fixture.agentAccessToken);
    sockets.push(agentSocket);
    await registerAgentAndWaitReady(agentSocket, fixture.agentId);

    const consumerSocket = await connectConsumer(serverA.baseUrl, fixture.clientAccessToken);
    sockets.push(consumerSocket);

    const startedPromise = waitForEvent<{
      success: boolean;
      conversationId?: string;
      error?: { code?: string; statusCode?: number; message?: string };
    }>(consumerSocket, socketEvents.relayConversationStarted);

    consumerSocket.emit(socketEvents.relayConversationStart, { agentId: fixture.agentId });
    const started = await startedPromise;

    expect(started.success).toBe(false);
    expect(started.conversationId).toBeUndefined();
    expect(started.error?.code).toBe("NOT_FOUND");
    expect(started.error?.statusCode).toBe(404);
    expect(started.error?.message).toMatch(new RegExp(fixture.agentId));
  });

  it("should complete relay rpc when consumer and agent share the same hub (sticky session)", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructure?.probe ?? { ok: false, reason: "probe missing" });
    assertInfrastructureOrSkip(ctx, bootstrapProbe);
    if (!env.socketConsumerRoles.includes("client")) {
      ctx.skip("SOCKET_CONSUMER_ROLES does not include client");
    }
    if (serverA === undefined || serverB === undefined) {
      throw new Error("distributed hub servers were not started");
    }

    const suffix = `relay-sticky-${Date.now()}`;
    const fixture = await seedRelayAgentFixture(serverA.baseUrl, suffix);
    createdAgentIds.add(fixture.agentId);

    const consumerSocket = await connectConsumer(serverA.baseUrl, fixture.clientAccessToken);
    const agentSocket = await connectAgent(serverA.baseUrl, fixture.agentAccessToken);
    sockets.push(consumerSocket, agentSocket);

    await registerAgentAndWaitReady(agentSocket, fixture.agentId);

    const startedPromise = waitForEvent<{
      success: boolean;
      conversationId: string;
    }>(consumerSocket, socketEvents.relayConversationStarted);
    consumerSocket.emit(socketEvents.relayConversationStart, { agentId: fixture.agentId });
    const started = await startedPromise;
    expect(started.success).toBe(true);
    expect(started.conversationId).toBeDefined();

    agentSocket.on("rpc:request", (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok || !isRecord(decoded.value.data)) {
        return;
      }
      const requestId = toRequestId(decoded.value.data.id);
      if (!requestId) {
        return;
      }
      agentSocket.emit(
        "rpc:response",
        encodePayloadFrame({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            conversation_id: started.conversationId,
            ok: true,
            hub: "sticky-a",
          },
        }),
      );
    });

    const acceptedPromise = waitForEvent<{
      success: boolean;
      requestId?: string;
      error?: { code?: string };
    }>(consumerSocket, socketEvents.relayRpcAccepted);
    const responsePromise = waitForEvent<unknown>(consumerSocket, socketEvents.relayRpcResponse);

    consumerSocket.emit(socketEvents.relayRpcRequest, {
      conversationId: started.conversationId,
      frame: encodePayloadFrame({
        jsonrpc: "2.0",
        id: "relay-multi-replica-1",
        method: "sql.execute",
        params: { sql: "SELECT 1", client_token: "relay-mr-token" },
      }),
    });

    const accepted = await acceptedPromise;
    expect(accepted.success).toBe(true);
    expect(accepted.requestId).toBeDefined();

    const rawResponse = await responsePromise;
    const decoded = decodePayloadFrame(rawResponse);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || !isRecord(decoded.value.data)) {
      throw new Error("Expected relay:rpc.response PayloadFrame");
    }
    const result = isRecord(decoded.value.data.result) ? decoded.value.data.result : null;
    expect(result?.ok).toBe(true);
    expect(result?.hub).toBe("sticky-a");
    expect(toRequestId(result?.conversation_id)).toBe(started.conversationId);
  });
});
