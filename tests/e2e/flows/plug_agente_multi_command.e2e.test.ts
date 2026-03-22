/**
 * E2E hub ↔ plug_agente: multi-command paths — JSON-RPC batch (array), `sql.executeBatch` (REST + Socket),
 * notification semantics (`id: null`), and mixed batches (REST + `agents:command`).
 */

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectConsumerSocket } from "../helpers/consumer_socket";
import { startE2EHubFixture, type E2EHubFixture } from "../helpers/e2e_hub_fixture";
import {
  connectPlugAgenteSocket,
  emitAgentRpcResponseWithAck,
  registerAgentOnHub,
  waitForSocketEvent,
} from "../helpers/plug_agente_socket";
import { decodePayloadFrame, encodePayloadFrame } from "../../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../src/shared/utils/rpc_types";

describe("E2E plug_agente multi-command (batch)", () => {
  let ctx: E2EHubFixture | undefined;

  beforeAll(async () => {
    ctx = await startE2EHubFixture();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("should proxy REST JSON-RPC batch (two sql.execute) and normalize batch response", async () => {
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const rpcHandled = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !Array.isArray(decoded.value.data)) {
            clearTimeout(t);
            reject(new Error("expected batch rpc:request as JSON-RPC array"));
            return;
          }

          const ids = decoded.value.data
            .map((item) => (isRecord(item) ? toRequestId(item.id) : null))
            .filter((id): id is string => id !== null);

          if (ids.length !== 2) {
            clearTimeout(t);
            reject(new Error(`expected 2 batch ids, got ${ids.length}`));
            return;
          }

          const [firstId, secondId] = ids;
          emitAgentRpcResponseWithAck(
            agentSocket,
            encodePayloadFrame([
              { jsonrpc: "2.0", id: firstId, result: { ok: true, batch_item: 1 } },
              { jsonrpc: "2.0", id: secondId, result: { ok: true, batch_item: 2 } },
            ]),
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
          command: [
            {
              jsonrpc: "2.0",
              method: "sql.execute",
              id: "e2e-batch-a",
              params: { sql: "SELECT 1", client_token: "e2e" },
            },
            {
              jsonrpc: "2.0",
              method: "sql.execute",
              id: "e2e-batch-b",
              params: { sql: "SELECT 2", client_token: "e2e" },
            },
          ],
        });

      const [res] = await Promise.all([httpPromise, rpcHandled]);
      expect(res.status).toBe(200);
      expect(res.body.response?.type).toBe("batch");
      expect(res.body.response?.success).toBe(true);
      expect(Array.isArray(res.body.response?.items)).toBe(true);
      expect(res.body.response.items).toHaveLength(2);
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should proxy REST sql.executeBatch as single rpc:request and accept single rpc:response", async () => {
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
          const data = decoded.value.data;
          if (data.method !== "sql.executeBatch") {
            clearTimeout(t);
            reject(new Error(`expected sql.executeBatch, got ${String(data.method)}`));
            return;
          }
          const params = isRecord(data.params) ? data.params : null;
          const commands = params && Array.isArray(params.commands) ? params.commands : null;
          if (!commands || commands.length !== 2) {
            clearTimeout(t);
            reject(new Error("expected params.commands with 2 entries"));
            return;
          }

          const id = toRequestId(data.id);
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
              result: { ok: true, executed: 2, source: "e2e-execute-batch" },
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
            method: "sql.executeBatch",
            id: "e2e-exec-batch-1",
            params: {
              client_token: "e2e",
              commands: [{ sql: "SELECT 1" }, { sql: "SELECT 2", execution_order: 1 }],
            },
          },
        });

      const [res] = await Promise.all([httpPromise, rpcHandled]);
      expect(res.status).toBe(200);
      expect(res.body.response?.type).toBe("single");
      expect(res.body.response?.success).toBe(true);
      const result = res.body.response?.item?.result;
      expect(isRecord(result) && result.source).toBe("e2e-execute-batch");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should proxy consumer agents:command JSON-RPC batch to agent and normalize", async () => {
    const consumer = await connectConsumerSocket(ctx.baseUrl, ctx.user.accessToken);
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const rpcHandled = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !Array.isArray(decoded.value.data)) {
            clearTimeout(t);
            reject(new Error("expected batch array on agents:command bridge"));
            return;
          }
          const ids = decoded.value.data
            .map((item) => (isRecord(item) ? toRequestId(item.id) : null))
            .filter((id): id is string => id !== null);
          if (ids.length !== 2) {
            clearTimeout(t);
            reject(new Error("expected two ids"));
            return;
          }
          emitAgentRpcResponseWithAck(
            agentSocket,
            encodePayloadFrame(
              ids.map((id, i) => ({
                jsonrpc: "2.0",
                id,
                result: { ok: true, socket_batch: i },
              })),
            ),
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
        response?: { type?: string; items?: unknown[]; success?: boolean };
      }>(consumer, "agents:command_response");

      consumer.emit("agents:command", {
        agentId: ctx.agentId,
        command: [
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "sock-b1",
            params: { sql: "SELECT 1", client_token: "e2e" },
          },
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "sock-b2",
            params: { sql: "SELECT 2", client_token: "e2e" },
          },
        ],
      });

      const [, cmdRes] = await Promise.all([rpcHandled, responsePromise]);
      expect(cmdRes.success).toBe(true);
      expect(cmdRes.response?.type).toBe("batch");
      expect(cmdRes.response?.success).toBe(true);
      expect(Array.isArray(cmdRes.response?.items)).toBe(true);
      expect(cmdRes.response?.items).toHaveLength(2);
    } finally {
      consumer.disconnect();
      agentSocket.disconnect();
    }
  });

  it("should return 202 for REST JSON-RPC single command with id: null (notification-only)", async () => {
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const sawRequest = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            clearTimeout(t);
            reject(new Error("expected single-object rpc:request"));
            return;
          }
          if (decoded.value.data.id !== null) {
            clearTimeout(t);
            reject(new Error("expected id: null to be preserved for notifications"));
            return;
          }
          clearTimeout(t);
          resolve();
        });
      });

      const httpPromise = request(ctx.baseUrl)
        .post("/api/v1/agents/commands")
        .set("Authorization", `Bearer ${ctx.user.accessToken}`)
        .send({
          agentId: ctx.agentId,
          command: {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: null,
            params: { sql: "SELECT 1", client_token: "e2e-notify" },
          },
        });

      const [res] = await Promise.all([httpPromise, sawRequest]);
      expect(res.status).toBe(202);
      expect(res.body.notification).toBe(true);
      expect(res.body.acceptedCommands).toBe(1);
      expect(res.body.mode).toBe("bridge");
      expect(res.body.agentId).toBe(ctx.agentId);
      expect(typeof res.body.requestId).toBe("string");
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should return 202 for REST JSON-RPC batch when every item is a notification (id: null)", async () => {
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const sawRequest = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !Array.isArray(decoded.value.data) || decoded.value.data.length !== 2) {
            clearTimeout(t);
            reject(new Error("expected two-item batch rpc:request"));
            return;
          }
          for (const item of decoded.value.data) {
            if (!isRecord(item) || item.id !== null) {
              clearTimeout(t);
              reject(new Error("expected each batch item to keep id: null"));
              return;
            }
          }
          clearTimeout(t);
          resolve();
        });
      });

      const httpPromise = request(ctx.baseUrl)
        .post("/api/v1/agents/commands")
        .set("Authorization", `Bearer ${ctx.user.accessToken}`)
        .send({
          agentId: ctx.agentId,
          command: [
            {
              jsonrpc: "2.0",
              method: "sql.execute",
              id: null,
              params: { sql: "SELECT 1", client_token: "e2e-n1" },
            },
            {
              jsonrpc: "2.0",
              method: "sql.execute",
              id: null,
              params: { sql: "SELECT 2", client_token: "e2e-n2" },
            },
          ],
        });

      const [res] = await Promise.all([httpPromise, sawRequest]);
      expect(res.status).toBe(202);
      expect(res.body.notification).toBe(true);
      expect(res.body.acceptedCommands).toBe(2);
      expect(res.body.agentId).toBe(ctx.agentId);
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should wait for 200 on REST batch mixing notification (id: null) and one call with id", async () => {
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const rpcHandled = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !Array.isArray(decoded.value.data) || decoded.value.data.length !== 2) {
            clearTimeout(t);
            reject(new Error("expected two-item mixed batch"));
            return;
          }
          const a = decoded.value.data[0];
          const b = decoded.value.data[1];
          if (!isRecord(a) || !isRecord(b)) {
            clearTimeout(t);
            reject(new Error("invalid batch items"));
            return;
          }
          if (a.id !== null) {
            clearTimeout(t);
            reject(new Error("first item should remain notification (id: null)"));
            return;
          }
          const callId = toRequestId(b.id);
          if (callId !== "e2e-mixed-call") {
            clearTimeout(t);
            reject(new Error(`expected second id e2e-mixed-call, got ${String(callId)}`));
            return;
          }

          emitAgentRpcResponseWithAck(
            agentSocket,
            encodePayloadFrame([
              { jsonrpc: "2.0", id: "e2e-mixed-call", result: { ok: true, mixed_notification_batch: true } },
            ]),
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
          command: [
            {
              jsonrpc: "2.0",
              method: "sql.execute",
              id: null,
              params: { sql: "SELECT 1", client_token: "e2e-mix-n" },
            },
            {
              jsonrpc: "2.0",
              method: "sql.execute",
              id: "e2e-mixed-call",
              params: { sql: "SELECT 2", client_token: "e2e-mix-c" },
            },
          ],
        });

      const [res] = await Promise.all([httpPromise, rpcHandled]);
      expect(res.status).toBe(200);
      expect(res.body.response?.type).toBe("batch");
      expect(res.body.response?.success).toBe(true);
      expect(res.body.response?.items).toHaveLength(1);
      expect(res.body.response?.items?.[0]?.id).toBe("e2e-mixed-call");
      const result = res.body.response?.items?.[0]?.result;
      expect(isRecord(result) && result.mixed_notification_batch).toBe(true);
    } finally {
      agentSocket.disconnect();
    }
  });

  it("should proxy consumer agents:command sql.executeBatch as single rpc:request and normalize", async () => {
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
          const data = decoded.value.data;
          if (data.method !== "sql.executeBatch") {
            clearTimeout(t);
            reject(new Error(`expected sql.executeBatch, got ${String(data.method)}`));
            return;
          }
          const id = toRequestId(data.id);
          if (id !== "e2e-sock-exec-batch") {
            clearTimeout(t);
            reject(new Error("unexpected id"));
            return;
          }
          emitAgentRpcResponseWithAck(
            agentSocket,
            encodePayloadFrame({
              jsonrpc: "2.0",
              id,
              result: { ok: true, source: "e2e-socket-execute-batch" },
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
        response?: { type?: string; item?: { result?: { source?: string } } };
      }>(consumer, "agents:command_response");

      consumer.emit("agents:command", {
        agentId: ctx.agentId,
        command: {
          jsonrpc: "2.0",
          method: "sql.executeBatch",
          id: "e2e-sock-exec-batch",
          params: {
            client_token: "e2e",
            commands: [{ sql: "SELECT 1" }],
          },
        },
      });

      const [, cmdRes] = await Promise.all([rpcHandled, responsePromise]);
      expect(cmdRes.success).toBe(true);
      expect(cmdRes.response?.type).toBe("single");
      expect(cmdRes.response?.item?.result?.source).toBe("e2e-socket-execute-batch");
    } finally {
      consumer.disconnect();
      agentSocket.disconnect();
    }
  });

  it("should return agents:command_response notification for single command with id: null", async () => {
    const consumer = await connectConsumerSocket(ctx.baseUrl, ctx.user.accessToken);
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const sawRequest = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !isRecord(decoded.value.data) || decoded.value.data.id !== null) {
            clearTimeout(t);
            reject(new Error("expected notification rpc:request with id: null"));
            return;
          }
          clearTimeout(t);
          resolve();
        });
      });

      const responsePromise = waitForSocketEvent<{
        success: boolean;
        requestId?: string;
        response?: { type?: string; accepted?: boolean; acceptedCommands?: number };
      }>(consumer, "agents:command_response");

      consumer.emit("agents:command", {
        agentId: ctx.agentId,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: null,
          params: { sql: "SELECT 1", client_token: "e2e-sock-n" },
        },
      });

      const [, cmdRes] = await Promise.all([sawRequest, responsePromise]);
      expect(cmdRes.success).toBe(true);
      expect(cmdRes.response?.type).toBe("notification");
      expect(cmdRes.response?.accepted).toBe(true);
      expect(cmdRes.response?.acceptedCommands).toBe(1);
      expect(typeof cmdRes.requestId).toBe("string");
    } finally {
      consumer.disconnect();
      agentSocket.disconnect();
    }
  });

  it("should return agents:command_response notification for batch of only id: null items", async () => {
    const consumer = await connectConsumerSocket(ctx.baseUrl, ctx.user.accessToken);
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const sawRequest = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !Array.isArray(decoded.value.data) || decoded.value.data.length !== 2) {
            clearTimeout(t);
            reject(new Error("expected two-item notification batch"));
            return;
          }
          for (const item of decoded.value.data) {
            if (!isRecord(item) || item.id !== null) {
              clearTimeout(t);
              reject(new Error("expected id: null on each item"));
              return;
            }
          }
          clearTimeout(t);
          resolve();
        });
      });

      const responsePromise = waitForSocketEvent<{
        success: boolean;
        response?: { type?: string; acceptedCommands?: number };
      }>(consumer, "agents:command_response");

      consumer.emit("agents:command", {
        agentId: ctx.agentId,
        command: [
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: null,
            params: { sql: "SELECT 1", client_token: "e2e-sb1" },
          },
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: null,
            params: { sql: "SELECT 2", client_token: "e2e-sb2" },
          },
        ],
      });

      const [, cmdRes] = await Promise.all([sawRequest, responsePromise]);
      expect(cmdRes.success).toBe(true);
      expect(cmdRes.response?.type).toBe("notification");
      expect(cmdRes.response?.acceptedCommands).toBe(2);
    } finally {
      consumer.disconnect();
      agentSocket.disconnect();
    }
  });

  it("should normalize agents:command mixed batch (notification + id) like REST", async () => {
    const consumer = await connectConsumerSocket(ctx.baseUrl, ctx.user.accessToken);
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const rpcHandled = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !Array.isArray(decoded.value.data) || decoded.value.data.length !== 2) {
            clearTimeout(t);
            reject(new Error("expected mixed batch"));
            return;
          }
          const first = decoded.value.data[0];
          const second = decoded.value.data[1];
          if (!isRecord(first) || first.id !== null || toRequestId(isRecord(second) ? second.id : null) !== "e2e-sock-mix") {
            clearTimeout(t);
            reject(new Error("unexpected batch shape"));
            return;
          }
          emitAgentRpcResponseWithAck(
            agentSocket,
            encodePayloadFrame([
              { jsonrpc: "2.0", id: "e2e-sock-mix", result: { ok: true, socket_mixed: true } },
            ]),
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
        response?: { type?: string; items?: { id?: string }[] };
      }>(consumer, "agents:command_response");

      consumer.emit("agents:command", {
        agentId: ctx.agentId,
        command: [
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: null,
            params: { sql: "SELECT 1", client_token: "e2e-sm-n" },
          },
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "e2e-sock-mix",
            params: { sql: "SELECT 2", client_token: "e2e-sm-c" },
          },
        ],
      });

      const [, cmdRes] = await Promise.all([rpcHandled, responsePromise]);
      expect(cmdRes.success).toBe(true);
      expect(cmdRes.response?.type).toBe("batch");
      expect(cmdRes.response?.items).toHaveLength(1);
      expect(cmdRes.response?.items?.[0]?.id).toBe("e2e-sock-mix");
    } finally {
      consumer.disconnect();
      agentSocket.disconnect();
    }
  });
});
