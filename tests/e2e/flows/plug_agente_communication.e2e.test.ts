/**
 * E2E focused on hub ↔ plug_agente contract:
 * `/agents` namespace (PayloadFrame, register, capabilities, heartbeat),
 * `rpc:request` / `rpc:response`, REST bridge and legacy consumer bridge.
 */

import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectConsumerSocket } from "../helpers/consumer_socket";
import { startE2EHubFixture, type E2EHubFixture } from "../helpers/e2e_hub_fixture";
import {
  connectPlugAgenteSocket,
  emitAgentHeartbeat,
  emitAgentRpcResponseWithAck,
  registerAgentOnHub,
  waitForSocketEvent,
} from "../helpers/plug_agente_socket";
import { decodePayloadFrame, encodePayloadFrame } from "../../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../src/shared/utils/rpc_types";

describe("E2E plug_agente communication (hub ↔ agent)", () => {
  let ctx: E2EHubFixture | undefined;

  beforeAll(async () => {
    ctx = await startE2EHubFixture();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe("/agents namespace (plug_agente transport)", () => {
    it("should complete handshake: connection:ready → agent:register → agent:capabilities", async () => {
      const socket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
      try {
        await registerAgentOnHub(socket, ctx.agentId);
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

  describe("REST bridge → agent (POST /api/v1/agents/commands)", () => {
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

        const responsePromise = waitForSocketEvent<{
          success: boolean;
          response?: { item?: { result?: { via?: string } } };
        }>(consumer, "agents:command_response");

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
