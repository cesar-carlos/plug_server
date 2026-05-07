import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { AGENT_REGISTER_SESSION_ACTIVE_MESSAGE } from "../../src/presentation/socket/hub/agent_register_error";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const registerApprovedUser = async (
  baseUrl: string,
  suffix: string,
): Promise<{ email: string; password: string }> => {
  const email = `agent-session-pol-${suffix}-${Date.now()}@test.com`;
  const password = "AgentSessionPol1";

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

describe("Agent session policy (reject_active)", () => {
  let server: TestServerResult;
  let baseUrl = "";

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();
  });

  afterAll(async () => {
    await server.close();
  });

  it("second agent:register receives session_active while first socket stays connected", async () => {
    const user = await registerApprovedUser(baseUrl, "reject");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);
    const token = agentLoginResponse.body.accessToken as string;

    const socketA = await connectAgent(baseUrl, token);
    try {
      const capabilitiesPromise = waitForEvent(socketA, "agent:capabilities");
      socketA.emit(
        "agent:register",
        encodePayloadFrame({
          agentId,
          capabilities: {
            protocols: ["jsonrpc-v2"],
            encodings: ["json"],
            compressions: ["none"],
            extensions: { protocolReadyAck: true },
          },
          timestamp: new Date().toISOString(),
        }),
      );
      await capabilitiesPromise;

      const socketB = await connectAgent(baseUrl, token);
      try {
        const errorPromise = waitForEvent<Record<string, unknown>>(socketB, "agent:register_error");
        socketB.emit(
          "agent:register",
          encodePayloadFrame({
            agentId,
            capabilities: {
              protocols: ["jsonrpc-v2"],
              encodings: ["json"],
              compressions: ["none"],
              extensions: { protocolReadyAck: true },
            },
            timestamp: new Date().toISOString(),
          }),
        );
        const err = await errorPromise;
        expect(err.reason).toBe("session_active");
        expect(err.code).toBe(-32014);
        expect(err.message).toBe(AGENT_REGISTER_SESSION_ACTIVE_MESSAGE);
        expect(err.details).toEqual({ code: "same_agent_session_active" });
      } finally {
        socketB.disconnect();
      }
    } finally {
      socketA.disconnect();
    }
  });
});
