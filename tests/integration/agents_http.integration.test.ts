import { request as httpRequest } from "node:http";

import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer } from "../helpers/test_server";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../src/shared/utils/rpc_types";

const waitForEvent = <T>(
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  timeoutMs = 5_000,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
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
};

describe("Agents HTTP bridge", () => {
  const testAgentId = "38f677f9-7420-4f9e-a84c-9694f1234f0b";
  const email = `agents-http-${Date.now()}@test.com`;
  const password = "AgentsHttp1";

  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl = "";
  let accessToken = "";
  let agentAccessToken = "";
  let agentSocket: ReturnType<typeof ioClient> | null = null;

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();

    const registerResponse = await request(baseUrl).post("/api/v1/auth/register").send({
      email,
      password,
    });
    expect(registerResponse.status).toBe(201);
    accessToken = registerResponse.body.accessToken as string;

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId: testAgentId,
    });
    expect(agentLoginResponse.status).toBe(200);
    agentAccessToken = agentLoginResponse.body.accessToken as string;

    agentSocket = ioClient(`${baseUrl}/agents`, {
      auth: { token: agentAccessToken },
      transports: ["websocket"],
    });

    await waitForEvent<unknown>(agentSocket, "connection:ready");
    const capabilitiesPromise = waitForEvent<unknown>(agentSocket, "agent:capabilities");
    agentSocket.emit(
      "agent:register",
      encodePayloadFrame({
        agentId: testAgentId,
        capabilities: {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        },
      }),
    );
    await capabilitiesPromise;
  });

  afterAll(async () => {
    agentSocket?.disconnect();
    await server.close();
  });

  it("should require auth for GET /api/v1/agents", async () => {
    const response = await request(baseUrl).get("/api/v1/agents");
    expect(response.status).toBe(401);
  });

  it("should list connected agents for authenticated users", async () => {
    const response = await request(baseUrl)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.agents)).toBe(true);
    expect(response.body.count).toBeGreaterThanOrEqual(1);
    expect(
      (response.body.agents as Array<{ agentId?: string }>).some((agent) => agent.agentId === testAgentId),
    ).toBe(true);
  });

  it("should validate command payload on POST /api/v1/agents/commands", async () => {
    const response = await request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("should proxy command to a connected agent and return normalized response", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !isRecord(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Invalid rpc:request payload"));
          return;
        }

        const requestId = toRequestId(decoded.value.data.id);
        if (!requestId) {
          clearTimeout(timeout);
          reject(new Error("Missing rpc request id"));
          return;
        }

        agentSocket?.emit(
          "rpc:response",
          encodePayloadFrame({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              ok: true,
              rows: [{ id: 1, name: "alpha" }],
            },
          }),
        );
        clearTimeout(timeout);
        resolve();
      });
    });

    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "single-req-1",
          params: {
            sql: "SELECT 1",
            client_token: "token-value",
          },
        },
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("bridge");
    expect(response.body.agentId).toBe(testAgentId);
    expect(response.body.requestId).toBeDefined();
    expect(response.body.response?.type).toBe("single");
    expect(response.body.response?.success).toBe(true);
  });

  it("should accept JSON-RPC notification without id and return 202", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !isRecord(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Invalid rpc:request payload"));
          return;
        }

        if ("id" in decoded.value.data) {
          clearTimeout(timeout);
          reject(new Error("Notification payload should not include id"));
          return;
        }

        clearTimeout(timeout);
        resolve();
      });
    });

    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          params: {
            sql: "INSERT INTO logs (msg) VALUES ('ping')",
            client_token: "token-value",
          },
        },
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    expect(response.status).toBe(202);
    expect(response.body.mode).toBe("bridge");
    expect(response.body.agentId).toBe(testAgentId);
    expect(response.body.requestId).toBeDefined();
    expect(response.body.notification).toBe(true);
    expect(response.body.acceptedCommands).toBe(1);
  });

  it("should proxy JSON-RPC batch and return normalized batch response", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !Array.isArray(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Batch payload was not forwarded as array"));
          return;
        }

        const requestIds = decoded.value.data
          .map((item) => (isRecord(item) ? toRequestId(item.id) : null))
          .filter((id): id is string => id !== null);

        if (requestIds.length !== 2) {
          clearTimeout(timeout);
          reject(new Error("Expected exactly two batch IDs"));
          return;
        }
        const firstId = requestIds.at(0);
        const secondId = requestIds.at(1);
        if (!firstId || !secondId) {
          clearTimeout(timeout);
          reject(new Error("Missing batch correlation ids"));
          return;
        }

        agentSocket?.emit(
          "rpc:response",
          encodePayloadFrame([
            {
              jsonrpc: "2.0",
              id: firstId,
              result: { ok: true, row_count: 1 },
            },
            {
              jsonrpc: "2.0",
              id: secondId,
              result: { ok: true, row_count: 1 },
            },
          ]),
        );

        clearTimeout(timeout);
        resolve();
      });
    });

    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        command: [
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "batch-q1",
            params: {
              sql: "SELECT 1",
              client_token: "token-value",
            },
          },
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "batch-q2",
            params: {
              sql: "SELECT 2",
              client_token: "token-value",
            },
          },
        ],
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("bridge");
    expect(response.body.response?.type).toBe("batch");
    expect(response.body.response?.success).toBe(true);
    expect(Array.isArray(response.body.response?.items)).toBe(true);
    expect(response.body.response.items).toHaveLength(2);
  });

  it("should proxy mixed batch and keep notification items out of normalized response", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !Array.isArray(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Batch payload was not forwarded as array"));
          return;
        }

        const forwardedItems = decoded.value.data.filter((item): item is Record<string, unknown> => isRecord(item));
        if (forwardedItems.length !== 3) {
          clearTimeout(timeout);
          reject(new Error("Expected three forwarded batch items"));
          return;
        }

        const ids = forwardedItems
          .map((item) => toRequestId(item.id))
          .filter((id): id is string => id !== null);
        if (ids.length !== 2) {
          clearTimeout(timeout);
          reject(new Error("Expected exactly two correlated ids in mixed batch"));
          return;
        }

        const firstId = ids.at(0);
        const secondId = ids.at(1);
        if (!firstId || !secondId) {
          clearTimeout(timeout);
          reject(new Error("Missing batch correlation ids"));
          return;
        }

        agentSocket?.emit(
          "rpc:response",
          encodePayloadFrame([
            {
              jsonrpc: "2.0",
              id: firstId,
              result: { ok: true, row_count: 1 },
            },
            {
              jsonrpc: "2.0",
              id: secondId,
              result: { ok: true, row_count: 1 },
            },
          ]),
        );

        clearTimeout(timeout);
        resolve();
      });
    });

    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        command: [
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "mix-q1",
            params: {
              sql: "SELECT 1",
            },
          },
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            params: {
              sql: "INSERT INTO logs (msg) VALUES ('ok')",
            },
          },
          {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "mix-q2",
            params: {
              sql: "SELECT 2",
            },
          },
        ],
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("bridge");
    expect(response.body.response?.type).toBe("batch");
    expect(response.body.response?.success).toBe(true);
    expect(Array.isArray(response.body.response?.items)).toBe(true);
    expect(response.body.response.items).toHaveLength(2);
    expect(
      response.body.response.items.every((item: { id?: string | number | null }) => item.id !== null),
    ).toBe(true);
  });

  it("should accept rpc:response before rpc:request_ack", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !isRecord(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Invalid rpc:request payload"));
          return;
        }

        const requestId = toRequestId(decoded.value.data.id);
        if (!requestId) {
          clearTimeout(timeout);
          reject(new Error("Missing rpc request id"));
          return;
        }

        agentSocket?.emit(
          "rpc:response",
          encodePayloadFrame({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              ok: true,
              order: "response_first",
            },
          }),
        );

        setTimeout(() => {
          agentSocket?.emit(
            "rpc:request_ack",
            encodePayloadFrame({
              request_id: requestId,
              received_at: new Date().toISOString(),
            }),
          );
        }, 10);

        clearTimeout(timeout);
        resolve();
      });
    });

    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "out-of-order-ack",
          params: {
            sql: "SELECT 1",
            client_token: "token-value",
          },
        },
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    expect(response.status).toBe(200);
    expect(response.body.response?.type).toBe("single");
    expect(response.body.response?.success).toBe(true);
    expect(response.body.response?.item?.result?.order).toBe("response_first");
  });

  it("should handle malformed rpc:response flood without crashing the bridge", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", () => {
        for (let index = 0; index < 40; index += 1) {
          agentSocket?.emit("rpc:response", "not-a-payload-frame");
        }
        clearTimeout(timeout);
        resolve();
      });
    });

    const startedAtMs = Date.now();
    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        timeoutMs: 300,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "malformed-flood-req",
          params: {
            sql: "SELECT 1",
          },
        },
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    const elapsedMs = Date.now() - startedAtMs;

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it("should release pending correlation when HTTP client aborts", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const abortedRequestId = "aborted-request-id";
    const firstRequestSeen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for first rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !isRecord(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Invalid first rpc:request payload"));
          return;
        }

        const requestId = toRequestId(decoded.value.data.id);
        if (requestId !== abortedRequestId) {
          clearTimeout(timeout);
          reject(new Error(`Unexpected first request id: ${requestId ?? "<null>"}`));
          return;
        }

        clearTimeout(timeout);
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finalize = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const requestBody = JSON.stringify({
        agentId: testAgentId,
        timeoutMs: 30_000,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: abortedRequestId,
          params: {
            sql: "SELECT pg_sleep(10)",
          },
        },
      });
      const url = new URL(`${baseUrl}/api/v1/agents/commands`);

      const req = httpRequest(
        {
          method: "POST",
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(requestBody),
            authorization: `Bearer ${accessToken}`,
          },
        },
        (res) => {
          res.resume();
          res.on("end", finalize);
        },
      );

      req.on("error", finalize);
      req.write(requestBody);
      req.end();

      firstRequestSeen
        .then(() => {
          req.destroy();
          setTimeout(finalize, 120);
        })
        .catch(reject);
    });

    const secondRequestHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for second rpc:request")), 8_000);

      agentSocket?.once("rpc:request", (rawPayload: unknown) => {
        const decoded = decodePayloadFrame(rawPayload);
        if (!decoded.ok || !isRecord(decoded.value.data)) {
          clearTimeout(timeout);
          reject(new Error("Invalid second rpc:request payload"));
          return;
        }

        const requestId = toRequestId(decoded.value.data.id);
        if (requestId !== abortedRequestId) {
          clearTimeout(timeout);
          reject(new Error(`Unexpected second request id: ${requestId ?? "<null>"}`));
          return;
        }

        agentSocket?.emit(
          "rpc:response",
          encodePayloadFrame({
            jsonrpc: "2.0",
            id: requestId,
            result: { ok: true },
          }),
        );
        clearTimeout(timeout);
        resolve();
      });
    });

    const secondResponsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: abortedRequestId,
          params: {
            sql: "SELECT 1",
          },
        },
      });

    const [secondResponse] = await Promise.all([secondResponsePromise, secondRequestHandled]);
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body.response?.success).toBe(true);
  });

  it("should return 503 with Retry-After under per-agent overload burst", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const onRpcRequest = (rawPayload: unknown): void => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok || !isRecord(decoded.value.data)) {
        return;
      }

      const requestId = toRequestId(decoded.value.data.id);
      if (!requestId || !requestId.startsWith("overload-")) {
        return;
      }

      setTimeout(() => {
        agentSocket?.emit(
          "rpc:response",
          encodePayloadFrame({
            jsonrpc: "2.0",
            id: requestId,
            result: { ok: true },
          }),
        );
      }, 250);
    };
    agentSocket.on("rpc:request", onRpcRequest);

    const requestCount = 36;
    const requests = Array.from({ length: requestCount }, (_item, index) => {
      return request(baseUrl)
        .post("/api/v1/agents/commands")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          agentId: testAgentId,
          timeoutMs: 800,
          command: {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: `overload-${index}`,
            params: {
              sql: "SELECT 1",
            },
          },
        });
    });

    try {
      const responses = await Promise.all(requests);
      const rejectedWithRetryAfter = responses.filter(
        (item) => item.status === 503 && typeof item.headers["retry-after"] === "string",
      );

      expect(rejectedWithRetryAfter.length).toBeGreaterThan(0);
      expect(
        rejectedWithRetryAfter.some((item) => {
          const value = Number(item.headers["retry-after"]);
          return Number.isFinite(value) && value >= 1;
        }),
      ).toBe(true);
      expect(
        rejectedWithRetryAfter.some(
          (item) =>
            typeof item.body?.details?.retry_after_ms === "number" && item.body.details.retry_after_ms >= 0,
        ),
      ).toBe(true);
    } finally {
      agentSocket.off("rpc:request", onRpcRequest);
    }
  });

  it("should fail fast when agent disconnects while waiting for response", async () => {
    if (!agentSocket) {
      throw new Error("Agent socket not initialized");
    }

    const rpcHandled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for rpc:request")), 8_000);

      agentSocket?.once("rpc:request", () => {
        agentSocket?.disconnect();
        clearTimeout(timeout);
        resolve();
      });
    });

    const startedAtMs = Date.now();
    const responsePromise = request(baseUrl)
      .post("/api/v1/agents/commands")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        agentId: testAgentId,
        timeoutMs: 30_000,
        command: {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "disconnect-fast-fail",
          params: {
            sql: "SELECT pg_sleep(10)",
          },
        },
      });

    const [response] = await Promise.all([responsePromise, rpcHandled]);
    const elapsedMs = Date.now() - startedAtMs;

    expect(response.status).toBe(503);
    expect(elapsedMs).toBeLessThan(3_000);
  });
});
