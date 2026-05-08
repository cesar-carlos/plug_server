import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { env } from "../../src/shared/config/env";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const repositories = getTestRepositoryAccess();

const registerApprovedUser = async (
  baseUrl: string,
  suffix: string,
): Promise<{ email: string; password: string }> => {
  const email = `agent-self-socket-${suffix}-${Date.now()}@test.com`;
  const password = "AgentSelfSocket1";

  const registerResponse = await request(baseUrl).post("/api/v1/auth/register").send({
    email,
    password,
  });
  expect(registerResponse.status).toBe(201);
  await approveRegistrationByToken(baseUrl, registerResponse.body.approvalToken as string);

  return { email, password };
};

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

const registerAgentWithoutPullSync = async (
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
        extensions: {
          protocolReadyAck: true,
        },
      },
      timestamp: new Date().toISOString(),
    }),
  );
  await capabilitiesPromise;
};

const emitProfileUpdateAndWait = async (
  socket: ReturnType<typeof ioClient>,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const responsePromise = waitForEvent<unknown>(socket, "agent:profile.updated");
  socket.emit("agent:profile.update", encodePayloadFrame(payload));
  const rawPayload = await responsePromise;
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok || typeof decoded.value.data !== "object" || decoded.value.data === null) {
    throw new Error("Invalid agent:profile.updated payload");
  }
  return decoded.value.data as Record<string, unknown>;
};

describe("Agent self profile socket event", () => {
  let server: TestServerResult;
  let baseUrl = "";

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();
  });

  afterAll(async () => {
    await server.close();
  });

  it("agent:profile.update should persist the updated snapshot after registration", async () => {
    const user = await registerApprovedUser(baseUrl, "success");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentWithoutPullSync(agentSocket, agentId);

      const response = await emitProfileUpdateAndWait(agentSocket, {
        agent_id: agentId,
        name: "Socket Self Agent",
        trade_name: "Socket Trade",
        email: "socket-self@test.local",
        address: {
          city: "Cuiaba",
          state: "MT",
        },
        notes: "updated via socket",
      });

      expect(response.success).toBe(true);
      expect(response.agent_id).toBe(agentId);
      expect(response.profileUpdatedAt).toEqual(expect.any(String));
      expect((response.agent as Record<string, unknown>).name).toBe("Socket Self Agent");
      expect((response.agent as Record<string, unknown>).tradeName).toBe("Socket Trade");

      const persisted = await repositories.agent.findById(agentId);
      expect(persisted).not.toBeNull();
      expect(persisted?.name).toBe("Socket Self Agent");
      expect(persisted?.tradeName).toBe("Socket Trade");
      expect(persisted?.email).toBe("socket-self@test.local");
      expect(persisted?.city).toBe("Cuiaba");
      expect(persisted?.state).toBe("MT");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should require agent registration before agent:profile.update", async () => {
    const user = await registerApprovedUser(baseUrl, "preregister");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      const response = await emitProfileUpdateAndWait(agentSocket, {
        name: "Too Early",
      });

      expect(response.success).toBe(false);
      expect((response.error as Record<string, unknown>).code).toBe("BAD_REQUEST");
      expect(String((response.error as Record<string, unknown>).message)).toContain(
        "before agent registration",
      );
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should return validation failures through agent:profile.updated", async () => {
    const user = await registerApprovedUser(baseUrl, "validation");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentWithoutPullSync(agentSocket, agentId);

      const response = await emitProfileUpdateAndWait(agentSocket, {});

      expect(response.success).toBe(false);
      expect((response.error as Record<string, unknown>).code).toBe("BAD_REQUEST");
      expect(String((response.error as Record<string, unknown>).message)).toContain(
        "At least one mutable profile field",
      );
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should reject payload agent_id mismatches with a structured error", async () => {
    const user = await registerApprovedUser(baseUrl, "mismatch");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentWithoutPullSync(agentSocket, agentId);

      const response = await emitProfileUpdateAndWait(agentSocket, {
        agent_id: randomUUID(),
        name: "Should Fail",
      });

      expect(response.success).toBe(false);
      expect((response.error as Record<string, unknown>).code).toBe("FORBIDDEN");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should rate limit repeated agent:profile.update events", async () => {
    if (env.restAgentsCommandsRateLimitMax === 0) {
      return;
    }

    const user = await registerApprovedUser(baseUrl, "rate");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const agentSocket = await connectAgent(baseUrl, agentLoginResponse.body.accessToken as string);
    try {
      await registerAgentWithoutPullSync(agentSocket, agentId);

      let sawRateLimit = false;
      for (let index = 0; index < env.restAgentsCommandsRateLimitMax + 1; index += 1) {
        const response = await emitProfileUpdateAndWait(agentSocket, {
          name: `Socket Rate Agent ${index}`,
        });
        if (response.success === false) {
          expect((response.error as Record<string, unknown>).code).toBe("TOO_MANY_REQUESTS");
          sawRateLimit = true;
          break;
        }
      }

      expect(sawRateLimit).toBe(true);
    } finally {
      agentSocket.disconnect();
    }
  });
});
