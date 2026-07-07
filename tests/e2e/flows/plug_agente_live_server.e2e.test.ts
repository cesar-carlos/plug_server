/**
 * Live E2E against a running hub (production/staging), using a real online agent.
 * Does not spawn an isolated test server or a simulated /agents socket.
 *
 * Required env:
 * - E2E_LIVE_AGENT_ID
 * Optional:
 * - E2E_LIVE_HUB_URL (default https://plug-server.se7esistemassinop.com.br)
 * - E2E_LIVE_CLIENT_TOKEN (agent-side `params.client_token` for SQL/policy RPCs)
 */

import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectConsumerSocket,
  startE2ELiveHubFixture,
  type E2ELiveHubFixture,
} from "../helpers/e2e_live_hub_fixture";
import { decodeConsumerSocketPayload } from "../helpers/consumer_socket";
import { isRecord } from "../../../src/shared/utils/rpc_types";

const liveAgentId = process.env.E2E_LIVE_AGENT_ID?.trim();

describe.skipIf(!liveAgentId)("E2E live hub (real server + agent)", () => {
  let ctx!: E2ELiveHubFixture;

  beforeAll(async () => {
    ctx = await startE2ELiveHubFixture();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("should report ready on the live hub", async () => {
    const res = await request(ctx.baseUrl).get("/api/v1/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.checks?.database).toBe(true);
  });

  it("should list the target agent for the owner user", async () => {
    const res = await request(ctx.baseUrl)
      .get("/api/v1/me/agents")
      .query({ pageSize: 100 })
      .set("Authorization", `Bearer ${ctx.ownerAccessToken}`);

    expect(res.status).toBe(200);
    const agentIds = (res.body.agents as Array<{ agentId?: string }>).map((row) => row.agentId);
    expect(agentIds).toContain(ctx.agentId);
  });

  it("should list the target agent for an approved client", async () => {
    const res = await request(ctx.baseUrl)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${ctx.clientAccessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agentIds).toContain(ctx.agentId);
  });

  it("should dispatch rpc.discover via REST to the live agent", async () => {
    const res = await request(ctx.baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${ctx.clientAccessToken}`)
      .send({
        agentId: ctx.agentId,
        command: {
          jsonrpc: "2.0",
          id: `live-rest-${Date.now()}`,
          method: "rpc.discover",
          params: {},
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("bridge");
    expect(res.body.agentId).toBe(ctx.agentId);
    expect(res.body.response?.success).toBe(true);
    const result = res.body.response?.item?.result;
    expect(isRecord(result)).toBe(true);
    expect(result.openrpc).toBe("1.3.2");
  });

  it("should resolve client_token.getPolicy when E2E_LIVE_CLIENT_TOKEN is set", async () => {
    if (!ctx.agentClientToken) {
      return;
    }

    const res = await request(ctx.baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${ctx.clientAccessToken}`)
      .send({
        agentId: ctx.agentId,
        command: {
          jsonrpc: "2.0",
          id: `live-policy-${Date.now()}`,
          method: "client_token.getPolicy",
          params: { client_token: ctx.agentClientToken },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.response?.success).toBe(true);
    expect(res.body.response?.item?.success).toBe(true);
    expect(res.body.response?.item?.result?.is_revoked).toBe(false);
  });

  const executeClienteSelect = async (opts: {
    page?: number;
    pageSize: number;
    cursor?: string;
    requestIdSuffix?: string;
  }): Promise<unknown> => {
    if (!ctx.agentClientToken) {
      throw new Error("E2E_LIVE_CLIENT_TOKEN is required for Cliente pagination tests.");
    }

    const requestId = `live-cliente-${opts.requestIdSuffix ?? Date.now()}`;
    const body: Record<string, unknown> = {
      agentId: ctx.agentId,
      timeoutMs: 60_000,
      command: {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: {
          sql: "SELECT CodCliente, Nome FROM Cliente ORDER BY CodCliente",
          client_token: ctx.agentClientToken,
          options: {
            max_rows: opts.pageSize,
          },
        },
      },
    };

    if (opts.cursor !== undefined) {
      body.pagination = { cursor: opts.cursor };
    } else if (opts.page !== undefined) {
      body.pagination = { page: opts.page, pageSize: opts.pageSize };
    }

    const res = await request(ctx.baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${ctx.clientAccessToken}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("bridge");
    expect(res.body.agentId).toBe(ctx.agentId);
    expect(res.body.response?.success).toBe(true);

    const item = res.body.response?.item;
    expect(item?.success).toBe(true);
    expect(item?.id).toBe(requestId);

    const result = item?.result;
    expect(isRecord(result)).toBe(true);
    return result;
  };

  it("should return more than one row from paginated SELECT on Cliente", async () => {
    if (!ctx.agentClientToken) {
      throw new Error("E2E_LIVE_CLIENT_TOKEN is required for Cliente pagination test.");
    }

    const pageSize = 10;
    const result = await executeClienteSelect({ page: 1, pageSize, requestIdSuffix: "page-1" });
    if (!isRecord(result)) {
      return;
    }

    const rows = Array.isArray(result.rows) ? result.rows : [];
    expect(rows.length).toBeGreaterThan(1);
    expect(result.row_count).toBeGreaterThan(1);

    const pagination = result.pagination;
    expect(isRecord(pagination)).toBe(true);
    if (isRecord(pagination)) {
      expect(pagination.page).toBe(1);
      expect(pagination.page_size).toBe(pageSize);
      expect(pagination.returned_rows).toBeGreaterThan(1);
      expect(pagination.has_next_page).toBe(true);
    }

    for (const row of rows.slice(0, 3)) {
      expect(isRecord(row)).toBe(true);
      if (isRecord(row)) {
        expect(row).toHaveProperty("codcliente");
        expect(row).toHaveProperty("nome");
      }
    }
  });

  it("should return page 2 and next_cursor pages with different Cliente rows", async () => {
    const pageSize = 5;
    const page1 = await executeClienteSelect({ page: 1, pageSize, requestIdSuffix: "p1" });
    const page2 = await executeClienteSelect({ page: 2, pageSize, requestIdSuffix: "p2" });

    if (!isRecord(page1) || !isRecord(page2)) {
      return;
    }

    const rows1 = Array.isArray(page1.rows) ? page1.rows : [];
    const rows2 = Array.isArray(page2.rows) ? page2.rows : [];
    expect(rows1.length).toBeGreaterThan(0);
    expect(rows2.length).toBeGreaterThan(0);

    const pagination1 = page1.pagination;
    const pagination2 = page2.pagination;
    expect(isRecord(pagination1)).toBe(true);
    expect(isRecord(pagination2)).toBe(true);
    if (!isRecord(pagination1) || !isRecord(pagination2)) {
      return;
    }

    expect(pagination1.page).toBe(1);
    expect(pagination2.page).toBe(2);
    expect(pagination1.has_next_page).toBe(true);
    expect(pagination2.has_previous_page).toBe(true);
    expect(typeof pagination1.next_cursor).toBe("string");
    expect(pagination1.next_cursor).toBeTruthy();

    const firstPage1 = rows1[0];
    const firstPage2 = rows2[0];
    expect(isRecord(firstPage1) && isRecord(firstPage2)).toBe(true);
    if (isRecord(firstPage1) && isRecord(firstPage2)) {
      expect(firstPage1.codcliente).not.toBe(firstPage2.codcliente);
    }

    const viaCursor = await executeClienteSelect({
      cursor: String(pagination1.next_cursor),
      pageSize,
      requestIdSuffix: "cursor-p2",
    });
    if (!isRecord(viaCursor)) {
      return;
    }

    const cursorRows = Array.isArray(viaCursor.rows) ? viaCursor.rows : [];
    expect(cursorRows.length).toBeGreaterThan(0);
    const cursorPagination = viaCursor.pagination;
    expect(isRecord(cursorPagination)).toBe(true);
    if (isRecord(cursorPagination)) {
      expect(cursorPagination.page).toBe(2);
    }
    if (isRecord(firstPage2) && cursorRows.length > 0 && isRecord(cursorRows[0])) {
      expect(cursorRows[0].codcliente).toBe(firstPage2.codcliente);
    }
  });

  it("should forward agents:command to the live agent on /consumers", async () => {
    const consumer = await connectConsumerSocket(ctx.baseUrl, ctx.clientAccessToken);
    try {
      const commandId = `live-socket-${Date.now()}`;
      const responsePromise = new Promise<{
        success: boolean;
        response?: { item?: { result?: { openrpc?: string } } };
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("agents:command_response timeout")), 20_000);
        consumer.once("agents:command_response", (raw: unknown) => {
          clearTimeout(timer);
          try {
            resolve(
              decodeConsumerSocketPayload<{
                success: boolean;
                response?: { item?: { result?: { openrpc?: string } } };
              }>(raw),
            );
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      consumer.emit("agents:command", {
        agentId: ctx.agentId,
        command: {
          jsonrpc: "2.0",
          id: commandId,
          method: "rpc.discover",
          params: {},
        },
      });

      const cmdRes = await responsePromise;
      expect(cmdRes.success).toBe(true);
      expect(cmdRes.response?.item?.result?.openrpc).toBe("1.3.2");
    } finally {
      consumer.disconnect();
      await delay(200);
    }
  });
});
