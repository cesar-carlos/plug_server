import { randomUUID } from "node:crypto";

import request from "supertest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prismaClient } from "../../src/infrastructure/database/prisma/client";
import { env } from "../../src/shared/config/env";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord } from "../../src/shared/utils/rpc_types";
import {
  spawnDistributedHubProcess,
  type DistributedHubProcess,
} from "./helpers/distributed_hub_process";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { trackPrismaTestPrincipal } from "../helpers/prisma_test_principal_cleanup";
import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeDistributedRedisInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

/**
 * Relay bridge state (conversationRegistry, agentRegistry, pending RPC routes) is
 * process-local — see docs/socket_relay_protocol.md § "Process-local". The
 * Socket.IO Redis adapter only synchronizes rooms/broadcast (e.g. client:custom.*),
 * not relay dispatch. These tests document expected multi-replica behaviour:
 * cross-replica consumer↔agent fails; same-hub (sticky) succeeds with Redis enabled.
 */

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

const registerAgentAndWaitReady = async (socket: ClientSocket, agentId: string): Promise<void> => {
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
  trackPrismaTestPrincipal({ agentId });
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

describe("REST profiles with two Prisma/Redis replicas", () => {
  let serverA: DistributedHubProcess | undefined, serverB: DistributedHubProcess | undefined;
  let probe: InfrastructureProbeResult = { ok: false, reason: "not started" };
  const sockets: ClientSocket[] = [];
  beforeAll(async () => {
    const infrastructure = await probeDistributedRedisInfrastructure();
    probe = infrastructure.probe;
    if (!probe.ok) return;
    const options = {
      socketIoRedisAdapterUrl: infrastructure.socketIoRedisAdapterUrl,
      restSocketEventIdempotencyRedisUrl: infrastructure.restSocketEventIdempotencyRedisUrl,
      agentHubPresenceRedisUrl: infrastructure.socketIoRedisAdapterUrl,
    };
    serverA = await spawnDistributedHubProcess({
      ...options,
      hubInstanceId: "rest-presence-hub-a",
    });
    serverB = await spawnDistributedHubProcess({
      ...options,
      hubInstanceId: "rest-presence-hub-b",
    });
  }, integrationHookTimeoutMs);
  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await Promise.all([serverA?.close(), serverB?.close()]);
  });
  it("revalidates remote REST presence and keeps the persisted fallback across replicas", async (ctx) => {
    assertInfrastructureOrSkip(ctx, probe);
    if (serverA === undefined || serverB === undefined) throw new Error("Missing distributed hubs");
    const fixture = await seedRelayAgentFixture(serverA.baseUrl, `rest-presence-${Date.now()}`);
    const agent = await connectAgent(serverB.baseUrl, fixture.agentAccessToken);
    sockets.push(agent);
    await registerAgentAndWaitReady(agent, fixture.agentId);
    let rpcs = 0;
    agent.on(socketEvents.rpcRequest, (raw: unknown) => {
      const decoded = decodePayloadFrame(raw);
      if (!decoded.ok || !isRecord(decoded.value.data)) throw new Error("Malformed profile RPC");
      const command = decoded.value.data;
      if (command.method !== "agent.getProfile") return;
      rpcs++;
      agent.emit(
        socketEvents.rpcResponse,
        encodePayloadFrame(
          {
            jsonrpc: "2.0",
            id: command.id,
            result: {
              agent_id: fixture.agentId,
              profile: { name: "Remote Refreshed Profile" },
              profile_version: 1,
              updated_at: new Date().toISOString(),
            },
          },
          { requestId: String(command.id) },
        ),
      );
    });
    const local = await request(serverB.baseUrl)
      .get("/api/v1/client/me/agents?refresh=true")
      .set("Authorization", `Bearer ${fixture.clientAccessToken}`);
    expect(local.status).toBe(200);
    expect(local.body.agents[0].name).toBe("Remote Refreshed Profile");
    expect(rpcs).toBe(1);
    await expect
      .poll(
        async () =>
          (
            await request(serverA!.baseUrl)
              .get("/api/v1/client/me/agents")
              .set("Authorization", `Bearer ${fixture.clientAccessToken}`)
          ).body.agents[0].isHubConnected,
        { timeout: 5000 },
      )
      .toBe(true);
    const page = await request(serverA.baseUrl)
      .get("/api/v1/client/me/agents?refresh=true")
      .set("Authorization", `Bearer ${fixture.clientAccessToken}`);
    expect(page.status).toBe(200);
    expect(page.body.agents[0]).toMatchObject({
      name: "Remote Refreshed Profile",
      isHubConnected: true,
    });
    const detail = await request(serverA.baseUrl)
      .get(`/api/v1/client/me/agents/${fixture.agentId}`)
      .set("Authorization", `Bearer ${fixture.clientAccessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.isHubConnected).toBe(true);
    agent.disconnect();
    await expect
      .poll(
        async () =>
          (
            await request(serverA!.baseUrl)
              .get(`/api/v1/client/me/agents/${fixture.agentId}`)
              .set("Authorization", `Bearer ${fixture.clientAccessToken}`)
          ).body.agent.isHubConnected,
        { timeout: 5000 },
      )
      .toBe(false);
  });
});
