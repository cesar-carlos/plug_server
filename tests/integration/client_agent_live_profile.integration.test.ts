import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { env } from "../../src/shared/config/env";
import { Client } from "../../src/domain/entities/client.entity";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { isRecord, toRequestId } from "../../src/shared/utils/rpc_types";
import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";
import { nextValidTestCnpj } from "./helpers/valid_test_cnpj";

const repositories = getTestRepositoryAccess();

const connectAgent = (baseUrl: string, token: string): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agents`, {
      auth: { token },
      transports: ["websocket"],
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

const connectConsumer = (baseUrl: string, token: string): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token },
      transports: ["websocket"],
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

const waitForEvent = <T>(
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  timeoutMs = 6_000,
): Promise<T> =>
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
  socket: ReturnType<typeof ioClient>,
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

const waitForAgentGetProfileRequest = async (
  socket: ReturnType<typeof ioClient>,
  timeoutMs = 6_000,
): Promise<string> => {
  const rawPayload = await waitForEvent<unknown>(socket, "rpc:request", timeoutMs);
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok || !isRecord(decoded.value.data)) {
    throw new Error("Invalid agent.getProfile rpc:request payload");
  }
  if (decoded.value.data.method !== "agent.getProfile") {
    throw new Error(`Expected agent.getProfile, got ${String(decoded.value.data.method)}`);
  }

  const rpcId = toRequestId(decoded.value.data.id);
  if (!rpcId) {
    throw new Error("Expected JSON-RPC id on agent.getProfile");
  }
  return rpcId;
};

const emitAgentProfileResponse = (
  socket: ReturnType<typeof ioClient>,
  rpcId: string,
  agentId: string,
  profile: {
    readonly name: string;
    readonly trade_name?: string;
    readonly document?: string;
    readonly document_type?: "cpf" | "cnpj";
    readonly phone?: string;
    readonly mobile?: string;
    readonly email?: string;
    readonly address?: {
      readonly street?: string;
      readonly number?: string;
      readonly district?: string;
      readonly postal_code?: string;
      readonly city?: string;
      readonly state?: string;
    };
    readonly notes?: string;
  },
  options?: {
    readonly responseAgentId?: string;
    readonly updatedAt?: string | null;
    readonly profileVersion?: number;
  },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for hub ack on rpc:response"));
    }, 10_000);

    socket.emit(
      "rpc:response",
      encodePayloadFrame({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          agent_id: options?.responseAgentId ?? agentId,
          ...(options?.updatedAt === null
            ? {}
            : { updated_at: options?.updatedAt ?? new Date().toISOString() }),
          ...(options?.profileVersion !== undefined
            ? { profile_version: options.profileVersion }
            : {}),
          profile,
        },
      }),
      () => {
        clearTimeout(timeout);
        resolve();
      },
    );
  });

describe("Client agent live profile API", () => {
  let server: TestServerResult;
  let baseUrl = "";

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();
  });

  afterAll(async () => {
    await server.close();
  });

  it("GET /api/v1/client/me/agents/:agentId prefers the online agent profile and persists it", async () => {
    const session = await registerOwnerAndClientSession(baseUrl);
    const agentId = randomUUID();

    await seedAgent({
      agentId,
      name: "Catalog Stub Agent",
      tradeName: "Catalog Stub Trade",
      cnpjCpf: `catalog-stub-${Date.now()}`,
      email: "catalog-stub@test.local",
      notes: "stale catalog snapshot",
    });
    await seedAgentBinding(session.owner.userId, agentId);
    await repositories.clientAgentAccess.addAccess(session.client.clientId, agentId);

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: session.owner.email,
      password: session.owner.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentAndWaitReady(agentSocket, agentId);

      const initialSyncDocument = nextValidTestCnpj();
      const initialSyncRpcId = await waitForAgentGetProfileRequest(agentSocket);
      await emitAgentProfileResponse(
        agentSocket,
        initialSyncRpcId,
        agentId,
        {
          name: "Initial Sync Agent",
          trade_name: "Initial Sync Trade",
          document: initialSyncDocument,
          document_type: "cnpj",
          mobile: "65990000001",
          email: "initial-sync@test.local",
          notes: "initial sync snapshot",
        },
        { profileVersion: 1 },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      const liveResponsePromise = request(baseUrl)
        .get(`/api/v1/client/me/agents/${agentId}`)
        .set("Authorization", `Bearer ${session.client.accessToken}`)
        .then((httpResponse) => httpResponse);

      const liveSyncRpcId = await waitForAgentGetProfileRequest(agentSocket);
      await emitAgentProfileResponse(
        agentSocket,
        liveSyncRpcId,
        agentId,
        {
          name: "Casa do Mel Tangara Ltda",
          trade_name: "Casa do Mel",
          document: "59261947000107",
          document_type: "cnpj",
          phone: "(00) 0000-0000",
          mobile: "65992865050",
          email: "tangara@casadomelfranquias.com.br",
          address: {
            street: "Avenida Brasil",
            number: "130",
            district: "Centro",
            postal_code: "78300096",
            city: "Tangara da Serra",
            state: "MT",
          },
          notes: "TESTE DE SISTEMA",
        },
        { profileVersion: 2 },
      );

      const response = await liveResponsePromise;

      expect(response.status).toBe(200);
      expect(response.body.agent.name).toBe("Casa do Mel Tangara Ltda");
      expect(response.body.agent.tradeName).toBe("Casa do Mel");
      expect(response.body.agent.document).toBe("59261947000107");
      expect(response.body.agent.phone).toBe("(00) 0000-0000");
      expect(response.body.agent.mobile).toBe("65992865050");
      expect(response.body.agent.email).toBe("tangara@casadomelfranquias.com.br");
      expect(response.body.agent.address).toMatchObject({
        street: "Avenida Brasil",
        number: "130",
        district: "Centro",
        postalCode: "78300096",
        city: "Tangara da Serra",
        state: "MT",
      });
      expect(response.body.agent.notes).toBe("TESTE DE SISTEMA");
      expect(response.body.agent.isHubConnected).toBe(true);

      const persisted = await repositories.agent.findById(agentId);
      expect(persisted).not.toBeNull();
      expect(persisted?.name).toBe("Casa do Mel Tangara Ltda");
      expect(persisted?.tradeName).toBe("Casa do Mel");
      expect(persisted?.document).toBe("59261947000107");
      expect(persisted?.phone).toBe("(00) 0000-0000");
      expect(persisted?.mobile).toBe("65992865050");
      expect(persisted?.email).toBe("tangara@casadomelfranquias.com.br");
      expect(persisted?.street).toBe("Avenida Brasil");
      expect(persisted?.postalCode).toBe("78300096");
      expect(persisted?.city).toBe("Tangara da Serra");
      expect(persisted?.state).toBe("MT");
      expect(persisted?.notes).toBe("TESTE DE SISTEMA");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("GET /api/v1/client/me/agents with refresh=true refreshes online agents in the returned page", async () => {
    const session = await registerOwnerAndClientSession(baseUrl);
    const liveAgentId = randomUUID();
    const offlineAgentId = randomUUID();
    const initialListSyncDocument = nextValidTestCnpj();
    const secondProfileDocument = nextValidTestCnpj();

    await seedAgent({
      agentId: liveAgentId,
      name: "Alpha Catalog Agent",
      tradeName: "Alpha Catalog",
      cnpjCpf: `alpha-catalog-${Date.now()}`,
    });
    await seedAgent({
      agentId: offlineAgentId,
      name: "Beta Persisted Agent",
      tradeName: "Beta Persisted",
      cnpjCpf: `beta-persisted-${Date.now()}`,
    });
    await seedAgentBinding(session.owner.userId, liveAgentId);
    await seedAgentBinding(session.owner.userId, offlineAgentId);
    await repositories.clientAgentAccess.addAccess(session.client.clientId, liveAgentId);
    await repositories.clientAgentAccess.addAccess(session.client.clientId, offlineAgentId);

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: session.owner.email,
      password: session.owner.password,
      agentId: liveAgentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentAndWaitReady(agentSocket, liveAgentId);

      const initialSyncRpcId = await waitForAgentGetProfileRequest(agentSocket);
      await emitAgentProfileResponse(
        agentSocket,
        initialSyncRpcId,
        liveAgentId,
        {
          name: "Alpha Synced Agent",
          trade_name: "Alpha Synced Trade",
          document: initialListSyncDocument,
          document_type: "cnpj",
        },
        { profileVersion: 1 },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      const listResponsePromise = request(baseUrl)
        .get("/api/v1/client/me/agents")
        .query({ refresh: true })
        .set("Authorization", `Bearer ${session.client.accessToken}`)
        .then((httpResponse) => httpResponse);

      const liveSyncRpcId = await waitForAgentGetProfileRequest(agentSocket);
      await emitAgentProfileResponse(
        agentSocket,
        liveSyncRpcId,
        liveAgentId,
        {
          name: "Alpha Live Refresh",
          trade_name: "Alpha Live Trade",
          document: secondProfileDocument,
          document_type: "cnpj",
          email: "alpha-live@test.local",
        },
        { profileVersion: 2 },
      );

      const response = await listResponsePromise;

      expect(response.status).toBe(200);
      const liveAgent = (response.body.agents as Array<Record<string, unknown>>).find(
        (agent) => agent.agentId === liveAgentId,
      );
      const offlineAgent = (response.body.agents as Array<Record<string, unknown>>).find(
        (agent) => agent.agentId === offlineAgentId,
      );
      expect(liveAgent?.name).toBe("Alpha Live Refresh");
      expect(liveAgent?.tradeName).toBe("Alpha Live Trade");
      expect(liveAgent?.email).toBe("alpha-live@test.local");
      expect(offlineAgent?.name).toBe("Beta Persisted Agent");
      expect(offlineAgent?.tradeName).toBe("Beta Persisted");
      expect(liveAgent?.isHubConnected).toBe(true);
      expect(offlineAgent?.isHubConnected).toBe(false);

      const persistedLive = await repositories.agent.findById(liveAgentId);
      expect(persistedLive?.name).toBe("Alpha Live Refresh");
      expect(persistedLive?.tradeName).toBe("Alpha Live Trade");
      expect(persistedLive?.email).toBe("alpha-live@test.local");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("GET /api/v1/client/me/agents/:agentId keeps the persisted snapshot when pull sync omits updated_at", async () => {
    const session = await registerOwnerAndClientSession(baseUrl);
    const agentId = randomUUID();

    await seedAgent({
      agentId,
      name: "Catalog Snapshot",
      tradeName: "Catalog Trade",
      cnpjCpf: `catalog-versioned-${Date.now()}`,
    });
    await seedAgentBinding(session.owner.userId, agentId);
    await repositories.clientAgentAccess.addAccess(session.client.clientId, agentId);

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: session.owner.email,
      password: session.owner.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentAndWaitReady(agentSocket, agentId);

      const initialSyncRpcId = await waitForAgentGetProfileRequest(agentSocket);
      await emitAgentProfileResponse(
        agentSocket,
        initialSyncRpcId,
        agentId,
        {
          name: "Versioned Snapshot",
          trade_name: "Versioned Trade",
          email: "versioned@test.local",
        },
        {
          updatedAt: "2026-04-08T10:30:00.000Z",
          profileVersion: 1,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      const liveResponsePromise = request(baseUrl)
        .get(`/api/v1/client/me/agents/${agentId}`)
        .set("Authorization", `Bearer ${session.client.accessToken}`)
        .then((httpResponse) => httpResponse);

      const liveSyncRpcId = await waitForAgentGetProfileRequest(agentSocket);
      await emitAgentProfileResponse(
        agentSocket,
        liveSyncRpcId,
        agentId,
        {
          name: "Unversioned Remote Snapshot",
          trade_name: "Should Not Overwrite",
          email: "stale@test.local",
        },
        {
          updatedAt: null,
        },
      );

      const response = await liveResponsePromise;

      expect(response.status).toBe(200);
      expect(response.body.agent.name).toBe("Versioned Snapshot");
      expect(response.body.agent.tradeName).toBe("Versioned Trade");
      expect(response.body.agent.email).toBe("versioned@test.local");
      expect(response.body.agent.isHubConnected).toBe(true);

      const persisted = await repositories.agent.findById(agentId);
      expect(persisted?.name).toBe("Versioned Snapshot");
      expect(persisted?.tradeName).toBe("Versioned Trade");
      expect(persisted?.email).toBe("versioned@test.local");
      expect(persisted?.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:30:00.000Z");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("emits client:agent.profile.updated to an approved client when the agent updates via HTTP", async () => {
    const session = await registerOwnerAndClientSession(baseUrl);
    const agentId = randomUUID();

    await seedAgent({
      agentId,
      name: "Broadcast Seed",
      tradeName: "Broadcast Trade",
      cnpjCpf: `broadcast-${Date.now()}`,
    });
    await seedAgentBinding(session.owner.userId, agentId);
    await repositories.clientAgentAccess.addAccess(session.client.clientId, agentId);

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: session.owner.email,
      password: session.owner.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const clientSocket = await connectConsumer(baseUrl, session.client.accessToken);
    try {
      const broadcastPromise = waitForEvent<unknown>(
        clientSocket,
        socketEvents.clientAgentProfileUpdated,
        8_000,
      );

      const patchResponse = await request(baseUrl)
        .patch(`/api/v1/agents/${agentId}/profile`)
        .set("Authorization", `Bearer ${agentLoginResponse.body.accessToken as string}`)
        .send({
          tradeName: "Broadcast Updated Trade",
          expectedProfileVersion: 0,
        });

      expect(patchResponse.status).toBe(200);

      const rawBroadcast = await broadcastPromise;
      const decoded = decodePayloadFrame(rawBroadcast);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) {
        return;
      }
      const data = decoded.value.data as Record<string, unknown>;
      expect(data.agent_id).toBe(agentId);
      expect(data.profile_version).toBe(1);
      expect(Array.isArray(data.changed_fields)).toBe(true);
    } finally {
      clientSocket.disconnect();
    }
  });

  it("does not emit client:agent.profile.updated to a client blocked after socket connect", async () => {
    const session = await registerOwnerAndClientSession(baseUrl);
    const agentId = randomUUID();

    await seedAgent({
      agentId,
      name: "Blocked Broadcast Seed",
      tradeName: "Blocked Broadcast Trade",
      cnpjCpf: `blocked-broadcast-${Date.now()}`,
    });
    await seedAgentBinding(session.owner.userId, agentId);
    await repositories.clientAgentAccess.addAccess(session.client.clientId, agentId);

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: session.owner.email,
      password: session.owner.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const clientSocket = await connectConsumer(baseUrl, session.client.accessToken);
    try {
      const persistedClient = await repositories.client.findById(session.client.clientId);
      expect(persistedClient).not.toBeNull();
      await repositories.client.save(
        new Client({
          ...persistedClient!,
          status: "blocked",
          updatedAt: new Date(),
        }),
      );

      const patchResponse = await request(baseUrl)
        .patch(`/api/v1/agents/${agentId}/profile`)
        .set("Authorization", `Bearer ${agentLoginResponse.body.accessToken as string}`)
        .send({
          tradeName: "Blocked Should Not Receive",
          expectedProfileVersion: 0,
        });

      expect(patchResponse.status).toBe(200);

      const receivedBroadcast = await waitForEvent<unknown>(
        clientSocket,
        socketEvents.clientAgentProfileUpdated,
        1_500,
      )
        .then(() => true)
        .catch(() => false);
      expect(receivedBroadcast).toBe(false);
    } finally {
      clientSocket.disconnect();
    }
  });
});
