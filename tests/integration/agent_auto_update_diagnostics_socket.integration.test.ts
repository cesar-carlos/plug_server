import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestServer } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";
import { env } from "../../src/shared/config/env";
import { container, getTestRepositoryAccess } from "../../src/shared/di/container";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../src/shared/metrics/socket_agent.metrics";

const repositories = getTestRepositoryAccess();

const waitForEvent = <T>(
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  timeoutMs = 5_000,
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

const validDiagnosticsParams = (agentId: string): Record<string, unknown> => ({
  agentId,
  appVersion: "1.6.8+1",
  checkId: "018f61a0-0000-7000-8000-000000000001",
  checkedAt: "2026-05-31T12:00:00.000Z",
  source: "background",
  completionSource: "updateNotAvailable",
  remoteVersion: null,
  updateAvailable: false,
  channel: "stable",
  rolloutBucket: 42,
  feedSignatureStatus: "valid",
  feedSignatureRequired: true,
  helperSignatureStatus: "valid",
  probeDurationMs: 123,
  downloadDurationMs: null,
  automaticFailureCount: 0,
  errorMessage: null,
});

describe("agent auto-update diagnostics socket ingress", () => {
  const agentId = "4c23cad9-d5ad-4ef7-90ad-321b881b0d56";
  const email = `diagnostics-agent-${Date.now()}@test.com`;
  const password = "DiagnosticsAgent1";

  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl = "";
  let agentSocket: ReturnType<typeof ioClient> | null = null;
  let originalEnabled: boolean;
  let originalWindowMs: number;
  let originalRateLimitMax: number;

  beforeAll(async () => {
    originalEnabled = env.agentAutoUpdateDiagnosticsEnabled;
    originalWindowMs = env.agentAutoUpdateDiagnosticsRateLimitWindowMs;
    originalRateLimitMax = env.agentAutoUpdateDiagnosticsRateLimitMax;
    env.agentAutoUpdateDiagnosticsEnabled = true;
    env.agentAutoUpdateDiagnosticsRateLimitWindowMs = 60_000;
    env.agentAutoUpdateDiagnosticsRateLimitMax = 1;

    server = await createTestServer();
    baseUrl = server.getUrl();

    const registerResponse = await request(baseUrl).post("/api/v1/auth/register").send({
      email,
      password,
    });
    expect(registerResponse.status).toBe(201);
    await approveRegistrationByToken(baseUrl, registerResponse.body.approvalToken as string);
    const userId = registerResponse.body.user.id as string;

    await seedAgent({
      agentId,
      name: "Diagnostics Agent",
      cnpjCpf: `diag-${userId.slice(0, 8)}`,
    });
    await seedAgentBinding(userId, agentId);

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    agentSocket = ioClient(`${baseUrl}/agents`, {
      auth: { token: agentLoginResponse.body.accessToken as string },
      transports: ["websocket"],
    });
    await waitForEvent<unknown>(agentSocket, socketEvents.connectionReady);
    const capabilitiesPromise = waitForEvent<unknown>(agentSocket, socketEvents.agentCapabilities);
    agentSocket.emit(
      socketEvents.agentRegister,
      encodePayloadFrame({
        agentId,
        capabilities: {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        },
      }),
    );
    await capabilitiesPromise;
  });

  afterEach(() => {
    resetSocketAgentMetrics();
    container.agentAutoUpdateDiagnosticsService.resetForTests();
  });

  afterAll(async () => {
    agentSocket?.disconnect();
    await server.close();
    env.agentAutoUpdateDiagnosticsEnabled = originalEnabled;
    env.agentAutoUpdateDiagnosticsRateLimitWindowMs = originalWindowMs;
    env.agentAutoUpdateDiagnosticsRateLimitMax = originalRateLimitMax;
  });

  it("persists a valid rpc:request notification and does not emit rpc:response", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }
    const responseFrames: unknown[] = [];
    agentSocket.on(socketEvents.rpcResponse, (frame: unknown) => {
      responseFrames.push(frame);
    });

    agentSocket.emit(
      socketEvents.rpcRequest,
      encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: validDiagnosticsParams(agentId),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await repositories.agentAutoUpdateDiagnostics.findRecentByAgentId(agentId, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId,
      appVersion: "1.6.8+1",
      source: "background",
      completionSource: "updateNotAvailable",
    });
    expect(responseFrames).toHaveLength(0);
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics.accepted).toBe(1);
  });

  it("drops invalid payloads and rate-limited pushes without breaking the socket session", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    agentSocket.emit(
      socketEvents.rpcRequest,
      encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validDiagnosticsParams(agentId),
          checkId: "invalid-extra",
          launcherPath: "C:\\private\\launcher.exe",
        },
      }),
    );
    agentSocket.emit(
      socketEvents.rpcRequest,
      encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validDiagnosticsParams(agentId),
          checkId: "accepted-before-rate-limit",
        },
      }),
    );
    agentSocket.emit(
      socketEvents.rpcRequest,
      encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validDiagnosticsParams(agentId),
          checkId: "rate-limited",
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(agentSocket.connected).toBe(true);
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics).toMatchObject({
      received: 3,
      accepted: 1,
      validationDrop: 1,
      rateLimitedDrop: 1,
    });
  });
});
