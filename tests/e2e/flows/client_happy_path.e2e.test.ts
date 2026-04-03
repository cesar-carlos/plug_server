import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startE2EHubFixture, type E2EHubFixture } from "../helpers/e2e_hub_fixture";
import { registerHubClient } from "../helpers/auth_tokens";
import {
  connectPlugAgenteSocket,
  emitAgentRpcResponseWithAck,
  registerAgentOnHub,
} from "../helpers/plug_agente_socket";
import { decodePayloadFrame, encodePayloadFrame } from "../../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../src/shared/utils/rpc_types";

describe("E2E client happy path", () => {
  let ctx!: E2EHubFixture;

  beforeAll(async () => {
    ctx = await startE2EHubFixture();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("registers client, approves access and dispatches command as client principal", async () => {
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const client = await registerHubClient(
        ctx.baseUrl,
        ctx.user.email,
        `e2e-client-${Date.now()}-${randomUUID().slice(0, 8)}@plug.test`,
        "E2eClient1",
      );

      const requestAccess = await request(ctx.baseUrl)
        .post("/api/v1/client/me/agents")
        .set("Authorization", `Bearer ${client.accessToken}`)
        .send({ agentIds: [ctx.agentId] });
      expect(requestAccess.status).toBe(200);
      expect(requestAccess.body.requested).toEqual([ctx.agentId]);

      const ownerRequests = await request(ctx.baseUrl)
        .get("/api/v1/me/client-access-requests")
        .set("Authorization", `Bearer ${ctx.user.accessToken}`)
        .query({ status: "pending", agentId: ctx.agentId });
      expect(ownerRequests.status).toBe(200);
      expect(ownerRequests.body.count).toBeGreaterThanOrEqual(1);
      const requestId = (ownerRequests.body.requests as Array<{ id: string; clientId: string }>).find(
        (item) => item.clientId === client.clientId,
      )?.id;
      expect(typeof requestId).toBe("string");

      const approve = await request(ctx.baseUrl)
        .post(`/api/v1/me/client-access-requests/${requestId as string}/approve`)
        .set("Authorization", `Bearer ${ctx.user.accessToken}`)
        .send({});
      expect(approve.status).toBe(200);
      expect(approve.body.approved).toBe(true);

      const approvedAgents = await request(ctx.baseUrl)
        .get("/api/v1/client/me/agents")
        .set("Authorization", `Bearer ${client.accessToken}`);
      expect(approvedAgents.status).toBe(200);
      expect(approvedAgents.body.agentIds).toContain(ctx.agentId);

      const rpcHandled = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("rpc:request timeout")), 15_000);
        agentSocket.once("rpc:request", (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            clearTimeout(timeout);
            reject(new Error("invalid rpc:request"));
            return;
          }

          const id = toRequestId(decoded.value.data.id);
          if (!id) {
            clearTimeout(timeout);
            reject(new Error("missing id"));
            return;
          }

          emitAgentRpcResponseWithAck(
            agentSocket,
            encodePayloadFrame({
              jsonrpc: "2.0",
              id,
              result: { ok: true, principal: "client", via: "client-e2e" },
            }),
          )
            .then(() => {
              clearTimeout(timeout);
              resolve();
            })
            .catch((error: unknown) => {
              clearTimeout(timeout);
              reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
      });

      const dispatchPromise = request(ctx.baseUrl)
        .post("/api/v1/agents/commands")
        .set("Authorization", `Bearer ${client.accessToken}`)
        .send({
          agentId: ctx.agentId,
          command: {
            jsonrpc: "2.0",
            id: "client-e2e-command",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
            },
          },
        });

      const [dispatch] = await Promise.all([dispatchPromise, rpcHandled]);
      expect(dispatch.status).toBe(200);
      expect(dispatch.body.response?.success).toBe(true);
      expect(dispatch.body.response?.item?.result).toEqual({
        ok: true,
        principal: "client",
        via: "client-e2e",
      });
    } finally {
      agentSocket.disconnect();
    }
  });
});
