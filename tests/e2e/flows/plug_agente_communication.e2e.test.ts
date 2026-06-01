/**
 * E2E focused on hub ↔ plug_agente contract:
 * `/agents` namespace (PayloadFrame, register, capabilities, heartbeat),
 * `rpc:request` / `rpc:response`, REST bridge and legacy consumer bridge.
 */

import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { connectConsumerSocket, decodeConsumerSocketPayload } from "../helpers/consumer_socket";
import { startE2EHubFixture, type E2EHubFixture } from "../helpers/e2e_hub_fixture";
import {
  connectPlugAgenteSocket,
  emitAgentHeartbeat,
  emitAgentReady,
  emitAgentRpcResponseWithAck,
  registerAgentOnHub,
  waitForSocketEvent,
} from "../helpers/plug_agente_socket";
import { decodePayloadFrame, encodePayloadFrame } from "../../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../src/shared/utils/rpc_types";
import { env } from "../../../src/shared/config/env";
import { container, getTestRepositoryAccess } from "../../../src/shared/di/container";
import {
  HUB_TRANSPORT_EXTENSIONS,
  HUB_TRANSPORT_LIMITS,
} from "../../../src/shared/constants/agent_transport_contract";

describe("E2E plug_agente communication (hub ↔ agent)", () => {
  /** Set in `beforeAll`; tests run after fixture is ready. */
  let ctx!: E2EHubFixture;
  const repositories = getTestRepositoryAccess();
  const originalDiagnosticsEnabled = env.agentAutoUpdateDiagnosticsEnabled;
  const originalDiagnosticsRateLimitWindowMs = env.agentAutoUpdateDiagnosticsRateLimitWindowMs;

  beforeAll(async () => {
    env.agentAutoUpdateDiagnosticsEnabled = true;
    env.agentAutoUpdateDiagnosticsRateLimitWindowMs = 60_000;
    ctx = await startE2EHubFixture();
  });

  afterEach(() => {
    container.agentAutoUpdateDiagnosticsService.resetForTests();
  });

  afterAll(async () => {
    await ctx.close();
    env.agentAutoUpdateDiagnosticsEnabled = originalDiagnosticsEnabled;
    env.agentAutoUpdateDiagnosticsRateLimitWindowMs = originalDiagnosticsRateLimitWindowMs;
  });

  const diagnosticsParams = (agentId: string, checkId: string): Record<string, unknown> => ({
    agentId,
    appVersion: "1.6.8+1",
    checkId,
    checkedAt: new Date().toISOString(),
    source: "background",
    completionSource: "updateNotAvailable",
    remoteVersion: null,
    updateAvailable: false,
    channel: "stable",
    rolloutBucket: 17,
    feedSignatureStatus: "valid",
    feedSignatureRequired: true,
    helperSignatureStatus: "valid",
    probeDurationMs: 12,
    downloadDurationMs: null,
    automaticFailureCount: 0,
    errorMessage: null,
  });

  const waitForDiagnosticsCheck = async (agentId: string, checkId: string): Promise<void> => {
    const deadlineAt = Date.now() + 5_000;
    while (Date.now() < deadlineAt) {
      const rows = await repositories.agentAutoUpdateDiagnostics.findRecentByAgentId(agentId, 20);
      if (rows.some((row) => row.checkId === checkId)) {
        return;
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for diagnostics check ${checkId}`);
  };

  describe("/agents namespace (plug_agente transport)", () => {
    it("should complete handshake: connection:ready → agent:register → agent:capabilities", async () => {
      const socket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(socket, ctx.agentId);
      } finally {
        socket.disconnect();
      }
    });

    it("should advertise negotiated transport limits in agent:capabilities", async () => {
      const socket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        const capabilitiesPromise = waitForSocketEvent<unknown>(socket, "agent:capabilities");
        socket.emit(
          "agent:register",
          encodePayloadFrame({
            agentId: ctx.agentId,
            timestamp: new Date().toISOString(),
            capabilities: {
              protocols: ["jsonrpc-v2"],
              encodings: ["json"],
              compressions: ["gzip", "none"],
              extensions: {
                binaryPayload: true,
                protocolReadyAck: true,
              },
              limits: {
                max_rows: 50_000,
                max_batch_size: 16,
              },
            },
          }),
        );

        const raw = await capabilitiesPromise;
        const decoded = decodePayloadFrame(raw);
        expect(decoded.ok).toBe(true);
        const data = decoded.ok && isRecord(decoded.value.data) ? decoded.value.data : null;
        const capabilities = isRecord(data?.capabilities) ? data.capabilities : null;
        expect(capabilities?.limits).toMatchObject(HUB_TRANSPORT_LIMITS);
        expect(capabilities?.extensions).toMatchObject({
          plugProfile: HUB_TRANSPORT_EXTENSIONS.plugProfile,
          transportFrame: HUB_TRANSPORT_EXTENSIONS.transportFrame,
          binaryPayload: true,
          protocolReadyAck: true,
        });
      } finally {
        socket.disconnect();
      }
    });

    it("should respond to agent:heartbeat with hub:heartbeat_ack (PayloadFrame)", async () => {
      const socket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(socket, ctx.agentId);
        const ackPromise = waitForSocketEvent<unknown>(socket, "hub:heartbeat_ack");
        emitAgentHeartbeat(socket, ctx.agentId);
        const raw = await ackPromise;
        const decoded = decodePayloadFrame(raw);
        expect(decoded.ok).toBe(true);
        if (decoded.ok && isRecord(decoded.value.data)) {
          expect(decoded.value.data.status).toBe("ok");
        }
      } finally {
        socket.disconnect();
      }
    });
  });

  describe("Agent -> hub diagnostics notification", () => {
    it("should persist diagnostics push without emitting rpc:response", async () => {
      const socket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      const responseFrames: unknown[] = [];
      try {
        await registerAgentOnHub(socket, ctx.agentId);
        socket.on("rpc:response", (frame: unknown) => {
          responseFrames.push(frame);
        });

        const checkId = `e2e-diagnostics-${Date.now()}`;
        socket.emit(
          "rpc:request",
          encodePayloadFrame({
            jsonrpc: "2.0",
            method: "agent.autoUpdate.diagnostics.push",
            params: diagnosticsParams(ctx.agentId, checkId),
          }),
        );

        await waitForDiagnosticsCheck(ctx.agentId, checkId);
        await delay(100);
        expect(responseFrames).toHaveLength(0);
      } finally {
        socket.disconnect();
      }
    });
  });

  describe("REST bridge → agent (POST /api/v1/agents/commands)", () => {
    it("should gate explicit-ready agents until agent:ready is emitted", async () => {
      const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(
          agentSocket,
          ctx.agentId,
          {
            protocols: ["jsonrpc-v2"],
            encodings: ["json"],
            compressions: ["gzip", "none"],
            extensions: {
              binaryPayload: true,
              protocolReadyAck: true,
            },
          },
          { autoReady: false },
        );

        const blocked = await request(ctx.baseUrl)
          .post("/api/v1/agents/commands")
          .set("Authorization", `Bearer ${ctx.user.accessToken}`)
          .send({
            agentId: ctx.agentId,
            command: {
              jsonrpc: "2.0",
              id: "e2e-explicit-ready-blocked",
              method: "rpc.discover",
              params: {},
            },
          });

        expect(blocked.status).toBe(503);
        expect(String(blocked.body.message)).toContain("protocol negotiation is not ready");

        await emitAgentReady(agentSocket, ctx.agentId);

        const rpcHandled = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
          agentSocket.once("rpc:request", (raw: unknown) => {
            const decoded = decodePayloadFrame(raw);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(t);
              reject(new Error("invalid rpc:request"));
              return;
            }
            const id = toRequestId(decoded.value.data.id);
            if (!id) {
              clearTimeout(t);
              reject(new Error("missing id"));
              return;
            }
            emitAgentRpcResponseWithAck(
              agentSocket,
              encodePayloadFrame({
                jsonrpc: "2.0",
                id,
                result: { ok: true, stage: "explicit-ready-e2e" },
              }),
            )
              .then(() => {
                clearTimeout(t);
                resolve();
              })
              .catch((err: unknown) => {
                clearTimeout(t);
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          });
        });

        const httpPromise = request(ctx.baseUrl)
          .post("/api/v1/agents/commands")
          .set("Authorization", `Bearer ${ctx.user.accessToken}`)
          .send({
            agentId: ctx.agentId,
            command: {
              jsonrpc: "2.0",
              id: "e2e-explicit-ready-ok",
              method: "rpc.discover",
              params: {},
            },
          });

        const [res] = await Promise.all([httpPromise, rpcHandled]);
        expect(res.status).toBe(200);
        expect(res.body.response?.success).toBe(true);
        expect(res.body.response?.item?.result?.stage).toBe("explicit-ready-e2e");
      } finally {
        agentSocket.disconnect();
      }
    });

    it("should surface client_token.getPolicy rate-limit retry hints as Retry-After", async () => {
      const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(agentSocket, ctx.agentId);

        const rpcHandled = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
          agentSocket.once("rpc:request", (raw: unknown) => {
            const decoded = decodePayloadFrame(raw);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(t);
              reject(new Error("invalid rpc:request"));
              return;
            }
            expect(decoded.value.data.method).toBe("client_token.getPolicy");
            const id = toRequestId(decoded.value.data.id);
            if (!id) {
              clearTimeout(t);
              reject(new Error("missing id"));
              return;
            }
            emitAgentRpcResponseWithAck(
              agentSocket,
              encodePayloadFrame({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32013,
                  message: "rate_limited",
                  data: {
                    reason: "client_token_get_policy_rate_limited",
                    retry_after_ms: 2_500,
                    reset_at: new Date(Date.now() + 2_500).toISOString(),
                  },
                },
              }),
            )
              .then(() => {
                clearTimeout(t);
                resolve();
              })
              .catch((err: unknown) => {
                clearTimeout(t);
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          });
        });

        const httpPromise = request(ctx.baseUrl)
          .post("/api/v1/agents/commands")
          .set("Authorization", `Bearer ${ctx.user.accessToken}`)
          .send({
            agentId: ctx.agentId,
            command: {
              jsonrpc: "2.0",
              id: "e2e-client-token-policy-rate-limit",
              method: "client_token.getPolicy",
              params: { client_token: "e2e" },
            },
          });

        const [res] = await Promise.all([httpPromise, rpcHandled]);
        expect(res.status).toBe(200);
        expect(res.headers["retry-after"]).toBe("3");
        expect(res.body.response?.item?.error?.code).toBe(-32013);
      } finally {
        agentSocket.disconnect();
      }
    });

    it("should deliver rpc:request as PayloadFrame and return normalized HTTP response", async () => {
      const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(agentSocket, ctx.agentId);

        const rpcHandled = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
          agentSocket.once("rpc:request", (raw: unknown) => {
            const decoded = decodePayloadFrame(raw);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(t);
              reject(new Error("invalid rpc:request"));
              return;
            }
            const id = toRequestId(decoded.value.data.id);
            if (!id) {
              clearTimeout(t);
              reject(new Error("missing id"));
              return;
            }
            emitAgentRpcResponseWithAck(
              agentSocket,
              encodePayloadFrame({
                jsonrpc: "2.0",
                id,
                result: { methods: [{ name: "rpc.discover" }], source: "e2e-plug-agente" },
              }),
            )
              .then(() => {
                clearTimeout(t);
                resolve();
              })
              .catch((err: unknown) => {
                clearTimeout(t);
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          });
        });

        const httpPromise = request(ctx.baseUrl)
          .post("/api/v1/agents/commands")
          .set("Authorization", `Bearer ${ctx.user.accessToken}`)
          .send({
            agentId: ctx.agentId,
            command: {
              jsonrpc: "2.0",
              id: "e2e-rest-1",
              method: "rpc.discover",
              params: {},
            },
          });

        const [res] = await Promise.all([httpPromise, rpcHandled]);
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe("bridge");
        expect(res.body.agentId).toBe(ctx.agentId);
        expect(res.body.response?.success).toBe(true);
        const item = res.body.response?.item;
        expect(isRecord(item?.result) && item?.result.source).toBe("e2e-plug-agente");
      } finally {
        agentSocket.disconnect();
      }
    });
  });

  describe("Consumer agents:command → hub → agent (legacy consumer path)", () => {
    it("should forward to same agent and return agents:command_response", async () => {
      const consumer = await connectConsumerSocket(ctx.baseUrl, ctx.user.accessToken);
      const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(agentSocket, ctx.agentId);

        const rpcHandled = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
          agentSocket.once("rpc:request", (raw: unknown) => {
            const decoded = decodePayloadFrame(raw);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(t);
              reject(new Error("invalid rpc:request"));
              return;
            }
            const id = toRequestId(decoded.value.data.id);
            if (!id) {
              clearTimeout(t);
              reject(new Error("missing id"));
              return;
            }
            emitAgentRpcResponseWithAck(
              agentSocket,
              encodePayloadFrame({
                jsonrpc: "2.0",
                id,
                result: { ok: true, via: "e2e-agents-command" },
              }),
            )
              .then(() => {
                clearTimeout(t);
                resolve();
              })
              .catch((err: unknown) => {
                clearTimeout(t);
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          });
        });

        const responsePromise = waitForSocketEvent<unknown>(
          consumer,
          "agents:command_response",
        ).then((raw) =>
          decodeConsumerSocketPayload<{
            success: boolean;
            response?: { item?: { result?: { via?: string } } };
          }>(raw),
        );

        consumer.emit("agents:command", {
          agentId: ctx.agentId,
          command: {
            jsonrpc: "2.0",
            id: "e2e-socket-1",
            method: "sql.execute",
            params: { sql: "SELECT 1", client_token: "e2e" },
          },
        });

        const [, cmdRes] = await Promise.all([rpcHandled, responsePromise]);
        expect(cmdRes.success).toBe(true);
        expect(cmdRes.response?.item?.result?.via).toBe("e2e-agents-command");
      } finally {
        consumer.disconnect();
        agentSocket.disconnect();
      }
    });
  });

  describe("Namespace / deprecated (plug_agente must use /agents)", () => {
    it("should reject default namespace / with NAMESPACE_DEPRECATED", async () => {
      await new Promise<void>((resolve, reject) => {
        const socket = ioClient(ctx.baseUrl, { transports: ["websocket"] });
        socket.on("app:error", (payload: { code?: string }) => {
          expect(payload.code).toBe("NAMESPACE_DEPRECATED");
          socket.disconnect();
          resolve();
        });
        socket.on("connect_error", (e) => {
          socket.disconnect();
          reject(e);
        });
        socket.on("connect", () => {
          /* server may disconnect after app:error */
        });
      });
    });
  });
});
