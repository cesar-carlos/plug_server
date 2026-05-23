import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  connectPlugAgenteSocket,
  registerAgentOnHub,
  waitForSocketEvent,
  type AgentSocket,
} from "../helpers/plug_agente_socket";
import { startE2EHubFixture, type E2EHubFixture } from "../helpers/e2e_hub_fixture";
import { env } from "../../../src/shared/config/env";
import {
  resetSocketAgentMetrics,
  getSocketAgentMetricsSnapshot,
} from "../../../src/shared/metrics/socket_agent.metrics";
import { decodePayloadFrame, encodePayloadFrame } from "../../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../src/shared/utils/rpc_types";

interface CapturedRpcRequest {
  readonly rawPayload: unknown;
  readonly data: unknown;
  readonly ids: readonly string[];
  readonly frameRequestId: string | null;
}

const originalInboundValidationMode = env.socketAgentInboundContractValidation;
const originalAckRetryEnabled = env.socketAgentAckRetryEnabled;
const originalAckRetryTimeoutMs = env.socketAgentAckTimeoutMs;
const originalAckMaxRetries = env.socketAgentAckMaxRetries;

const extractRpcRequestIds = (payload: unknown): readonly string[] => {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => (isRecord(item) ? toRequestId(item.id) : null))
      .filter((id): id is string => id !== null);
  }
  if (isRecord(payload)) {
    const id = toRequestId(payload.id);
    return id ? [id] : [];
  }
  return [];
};

const parseRpcRequest = (rawPayload: unknown): CapturedRpcRequest | null => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return null;
  }
  return {
    rawPayload,
    data: decoded.value.data,
    ids: extractRpcRequestIds(decoded.value.data),
    frameRequestId: toRequestId(decoded.value.frame.requestId),
  };
};

const emitAgentRpcResponse = (
  socket: AgentSocket,
  payload: unknown,
  frameRequestId: string | null,
): Promise<void> =>
  new Promise((resolve) => {
    socket.emit(
      "rpc:response",
      encodePayloadFrame(payload, frameRequestId ? { requestId: frameRequestId } : undefined),
      () => resolve(),
    );
  });

const waitForMatchingRpcRequest = (
  socket: AgentSocket,
  targetId: string,
  handler: (requestFrame: CapturedRpcRequest) => Promise<void> | void,
  timeoutMs = 8_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("rpc:request", onRpcRequest);
      reject(new Error(`Timed out waiting for rpc:request ${targetId}`));
    }, timeoutMs);

    const finish = (): void => {
      clearTimeout(timeout);
      socket.off("rpc:request", onRpcRequest);
      resolve();
    };

    const fail = (error: unknown): void => {
      clearTimeout(timeout);
      socket.off("rpc:request", onRpcRequest);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onRpcRequest = (rawPayload: unknown): void => {
      const requestFrame = parseRpcRequest(rawPayload);
      if (!requestFrame?.ids.includes(targetId)) {
        return;
      }
      Promise.resolve(handler(requestFrame)).then(finish).catch(fail);
    };

    socket.on("rpc:request", onRpcRequest);
  });

const postAgentCommand = (
  ctx: E2EHubFixture,
  command: unknown,
  timeoutMs?: number,
): request.Test => {
  const body: Record<string, unknown> = {
    agentId: ctx.agentId,
    command,
  };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  return request(ctx.baseUrl)
    .post("/api/v1/agents/commands")
    .set("Authorization", `Bearer ${ctx.user.accessToken}`)
    .send(body);
};

describe("E2E plug_agente contract hardening", () => {
  let ctx!: E2EHubFixture;
  let agentSocket!: AgentSocket;

  beforeAll(async () => {
    ctx = await startE2EHubFixture();
    agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    await registerAgentOnHub(agentSocket, ctx.agentId);
  });

  afterEach(() => {
    env.socketAgentInboundContractValidation = originalInboundValidationMode;
    env.socketAgentAckRetryEnabled = originalAckRetryEnabled;
    env.socketAgentAckTimeoutMs = originalAckRetryTimeoutMs;
    env.socketAgentAckMaxRetries = originalAckMaxRetries;
    resetSocketAgentMetrics();
  });

  afterAll(async () => {
    agentSocket.disconnect();
    await ctx.close();
  });

  it("rejects invalid inbound rpc:response in strict mode", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = false;
    resetSocketAgentMetrics();

    const requestId = "e2e-strict-invalid-response";
    const rpcHandled = waitForMatchingRpcRequest(agentSocket, requestId, async (requestFrame) => {
      await emitAgentRpcResponse(
        agentSocket,
        {
          jsonrpc: "2.0",
          id: requestId,
          result: { ok: true },
          meta: { extra: "not-published" },
        },
        requestFrame.frameRequestId,
      );
    });

    const [response] = await Promise.all([
      postAgentCommand(ctx, {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: { sql: "SELECT 1" },
      }),
      rpcHandled,
    ]);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation.failedTotal).toBeGreaterThan(
      0,
    );
  });

  it("processes invalid inbound rpc:response in warn mode and records a warning metric", async () => {
    env.socketAgentInboundContractValidation = "warn";
    env.socketAgentAckRetryEnabled = false;
    resetSocketAgentMetrics();

    const requestId = "e2e-warn-invalid-response";
    const rpcHandled = waitForMatchingRpcRequest(agentSocket, requestId, async (requestFrame) => {
      await emitAgentRpcResponse(
        agentSocket,
        {
          jsonrpc: "2.0",
          id: requestId,
          result: { ok: true, mode: "warn-processed" },
          meta: { extra: "not-published" },
        },
        requestFrame.frameRequestId,
      );
    });

    const [response] = await Promise.all([
      postAgentCommand(ctx, {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: { sql: "SELECT 1" },
      }),
      rpcHandled,
    ]);

    expect(response.status).toBe(200);
    expect(response.body.response?.item?.result?.mode).toBe("warn-processed");
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation).toEqual({
      failedTotal: 1,
      warnTotal: 1,
    });
  });

  it("records strict validation failure for invalid batch response", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = false;
    resetSocketAgentMetrics();

    const targetId = "e2e-invalid-batch-a";
    const rpcHandled = waitForMatchingRpcRequest(agentSocket, targetId, async (requestFrame) => {
      await emitAgentRpcResponse(
        agentSocket,
        [
          {
            jsonrpc: "2.0",
            id: targetId,
            result: {},
            error: { code: -32000, message: "failed" },
          },
        ],
        requestFrame.frameRequestId,
      );
    });

    const [response] = await Promise.all([
      postAgentCommand(
        ctx,
        [
          {
            jsonrpc: "2.0",
            id: targetId,
            method: "sql.execute",
            params: { sql: "SELECT 1" },
          },
          {
            jsonrpc: "2.0",
            id: "e2e-invalid-batch-b",
            method: "sql.execute",
            params: { sql: "SELECT 2" },
          },
        ],
        250,
      ),
      rpcHandled,
    ]);

    expect(response.status).toBe(503);
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation.failedTotal).toBeGreaterThan(
      0,
    );
  });

  it("rejects invalid rpc:chunk on a real REST stream", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = false;
    resetSocketAgentMetrics();

    const requestId = "e2e-invalid-chunk";
    const streamId = "stream-invalid-chunk";
    const rpcHandled = waitForMatchingRpcRequest(agentSocket, requestId, async (requestFrame) => {
      const pullPromise = waitForSocketEvent<unknown>(agentSocket, "rpc:stream.pull", 5_000);
      await emitAgentRpcResponse(
        agentSocket,
        {
          jsonrpc: "2.0",
          id: requestId,
          result: { stream_id: streamId, rows: [] },
        },
        requestFrame.frameRequestId,
      );
      await pullPromise;
      agentSocket.emit(
        "rpc:chunk",
        encodePayloadFrame(
          {
            stream_id: streamId,
            request_id: requestId,
            chunk_index: 0,
            rows: [],
            extra: true,
          },
          { requestId },
        ),
      );
    });

    const [response] = await Promise.all([
      postAgentCommand(ctx, {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: { sql: "SELECT 1" },
      }),
      rpcHandled,
    ]);

    expect(response.status).toBe(503);
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation.failedTotal).toBeGreaterThan(
      0,
    );
  });

  it("rejects invalid rpc:complete on a real REST stream", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = false;
    resetSocketAgentMetrics();

    const requestId = "e2e-invalid-complete";
    const streamId = "stream-invalid-complete";
    const rpcHandled = waitForMatchingRpcRequest(agentSocket, requestId, async (requestFrame) => {
      const pullPromise = waitForSocketEvent<unknown>(agentSocket, "rpc:stream.pull", 5_000);
      await emitAgentRpcResponse(
        agentSocket,
        {
          jsonrpc: "2.0",
          id: requestId,
          result: { stream_id: streamId, rows: [] },
        },
        requestFrame.frameRequestId,
      );
      await pullPromise;
      agentSocket.emit(
        "rpc:complete",
        encodePayloadFrame(
          {
            stream_id: streamId,
            request_id: requestId,
            total_rows: -1,
          },
          { requestId },
        ),
      );
    });

    const [response] = await Promise.all([
      postAgentCommand(ctx, {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: { sql: "SELECT 1" },
      }),
      rpcHandled,
    ]);

    expect(response.status).toBe(503);
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation.failedTotal).toBeGreaterThan(
      0,
    );
  });

  it("retries an ACK-eligible REST request once and reuses the same frame", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = true;
    env.socketAgentAckTimeoutMs = 30;
    env.socketAgentAckMaxRetries = 1;

    const requestId = "e2e-ack-retry-read";
    let deliveries = 0;
    const frameRequestIds = new Set<string | null>();
    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        agentSocket.off("rpc:request", onRpcRequest);
        reject(new Error("Timed out waiting for ACK retry"));
      }, 5_000);

      const onRpcRequest = (rawPayload: unknown): void => {
        const requestFrame = parseRpcRequest(rawPayload);
        if (!requestFrame?.ids.includes(requestId)) {
          return;
        }
        deliveries += 1;
        frameRequestIds.add(requestFrame.frameRequestId);
        if (deliveries !== 2) {
          return;
        }

        agentSocket.off("rpc:request", onRpcRequest);
        clearTimeout(timeout);
        emitAgentRpcResponse(
          agentSocket,
          { jsonrpc: "2.0", id: requestId, result: { ok: true, deliveries } },
          requestFrame.frameRequestId,
        )
          .then(resolve)
          .catch(reject);
      };

      agentSocket.on("rpc:request", onRpcRequest);
    });

    const [response] = await Promise.all([
      postAgentCommand(ctx, {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: { sql: "SELECT 1" },
      }),
      rpcHandled,
    ]);

    expect(response.status).toBe(200);
    expect(response.body.response?.item?.result?.deliveries).toBe(2);
    expect(deliveries).toBe(2);
    expect(frameRequestIds.size).toBe(1);
  });

  it("preserves idempotency key and request id across ACK retry", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = true;
    env.socketAgentAckTimeoutMs = 30;
    env.socketAgentAckMaxRetries = 1;

    const requestId = "e2e-ack-retry-idempotent-write";
    const idempotencyKey = "idem-e2e-ack-retry";
    let deliveries = 0;
    const seenKeys = new Set<string>();
    const seenIds = new Set<string>();
    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        agentSocket.off("rpc:request", onRpcRequest);
        reject(new Error("Timed out waiting for idempotent ACK retry"));
      }, 5_000);

      const onRpcRequest = (rawPayload: unknown): void => {
        const requestFrame = parseRpcRequest(rawPayload);
        if (!requestFrame?.ids.includes(requestId) || !isRecord(requestFrame.data)) {
          return;
        }
        deliveries += 1;
        seenIds.add(String(requestFrame.data.id));
        const params = isRecord(requestFrame.data.params) ? requestFrame.data.params : {};
        if (typeof params.idempotency_key === "string") {
          seenKeys.add(params.idempotency_key);
        }
        if (deliveries !== 2) {
          return;
        }

        agentSocket.off("rpc:request", onRpcRequest);
        clearTimeout(timeout);
        emitAgentRpcResponse(
          agentSocket,
          {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              deliveries,
              uniqueExecutionKeys: seenKeys.size,
              idempotencyKey: [...seenKeys][0],
            },
          },
          requestFrame.frameRequestId,
        )
          .then(resolve)
          .catch(reject);
      };

      agentSocket.on("rpc:request", onRpcRequest);
    });

    const [response] = await Promise.all([
      postAgentCommand(ctx, {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: {
          sql: "UPDATE accounts SET name = 'retry-safe'",
          idempotency_key: idempotencyKey,
        },
      }),
      rpcHandled,
    ]);

    expect(response.status).toBe(200);
    expect(response.body.response?.item?.result).toMatchObject({
      deliveries: 2,
      uniqueExecutionKeys: 1,
      idempotencyKey,
    });
    expect(seenIds).toEqual(new Set([requestId]));
  });

  it("does not retry a non-idempotent REST command when ACK is missing", async () => {
    env.socketAgentInboundContractValidation = "strict";
    env.socketAgentAckRetryEnabled = true;
    env.socketAgentAckTimeoutMs = 30;
    env.socketAgentAckMaxRetries = 1;

    const requestId = "e2e-no-ack-retry-non-idempotent";
    let deliveries = 0;
    let cleanupListener = (): void => undefined;
    const firstSeen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        agentSocket.off("rpc:request", onRpcRequest);
        reject(new Error("Timed out waiting for non-idempotent request"));
      }, 5_000);

      const onRpcRequest = (rawPayload: unknown): void => {
        const requestFrame = parseRpcRequest(rawPayload);
        if (!requestFrame?.ids.includes(requestId)) {
          return;
        }
        deliveries += 1;
        clearTimeout(timeout);
        resolve();
      };

      agentSocket.on("rpc:request", onRpcRequest);
      cleanupListener = () => {
        clearTimeout(timeout);
        agentSocket.off("rpc:request", onRpcRequest);
      };
    });

    const responsePromise = postAgentCommand(
      ctx,
      {
        jsonrpc: "2.0",
        id: requestId,
        method: "sql.execute",
        params: { sql: "UPDATE accounts SET name = 'unsafe'" },
      },
      180,
    ).then((response) => response);

    await firstSeen;
    const response = await responsePromise;
    cleanupListener();

    expect(response.status).toBe(503);
    expect(deliveries).toBe(1);
  });
});
