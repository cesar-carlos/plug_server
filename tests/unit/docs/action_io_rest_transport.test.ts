import { expect, it } from "vitest";
import { createRestActionIoTransport } from "../../../docs/snippets/action_io_rest_transport";
const command = {
  jsonrpc: "2.0" as const,
  id: "request",
  method: "agent.action.findExecution",
  params: { action_id: "a", idempotency_key: "k" },
};
it("returns a safe typed error for malformed HTTP JSON instead of exposing response content", async () => {
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () => new Response("private-invalid-response"),
  });
  const failure = await transport(command).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "INVALID_HTTP_JSON", outcomeUnknown: true });
  expect(String(failure)).not.toContain("private-invalid-response");
});
it("rejects invalid UTF-8 instead of silently substituting bytes in JSON", async () => {
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () => new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])),
  });
  await expect(transport(command)).rejects.toMatchObject({
    code: "INVALID_HTTP_JSON",
    outcomeUnknown: true,
  });
});
it("preserves the response size failure when stream cleanup also fails", async () => {
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            throw new Error("private cleanup detail");
          },
        }),
      ),
  });
  await expect(transport(command)).rejects.toMatchObject({
    code: "HTTP_RESPONSE_TOO_LARGE",
    outcomeUnknown: true,
    details: { cleanup_failed: true },
  });
});
it("uses the normalized REST bridge envelope without changing the RPC result", async () => {
  const result = { found: false, execution_id: null, reason: "not_found_in_retention_window" };
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid/api/v1/agents/commands",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async (url, init) => {
      expect(url).toBe("https://fixture.invalid/api/v1/agents/commands");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        agentId: "agent",
        command,
        timeoutMs: 30000,
      });
      return Response.json({
        agentId: "agent",
        response: { type: "single", item: { id: "request", success: true, result } },
      });
    },
  });
  expect(await transport(command)).toEqual({ jsonrpc: "2.0", id: "request", result });
});
it("rejects another agent's response and oversized bodies without retry", async () => {
  let calls = 0;
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () => {
      calls++;
      return new Response("x".repeat(1024 * 1024 + 1));
    },
  });
  await expect(transport(command)).rejects.toMatchObject({ code: "HTTP_RESPONSE_TOO_LARGE" });
  expect(calls).toBe(1);
  const wrongAgent = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () =>
      Response.json({
        agentId: "other",
        response: { type: "single", item: { id: "request", success: true, result: {} } },
      }),
  });
  await expect(wrongAgent(command)).rejects.toMatchObject({ code: "HTTP_200_INVALID_ENVELOPE" });
});

it("preserves RPC metadata for downstream size and protocol validation", async () => {
  const meta = { trace_id: "trace", timestamp: "2026-10-29T00:00:00Z" };
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () =>
      Response.json({
        agentId: "agent",
        response: {
          type: "single",
          item: { id: "request", success: true, result: {}, api_version: "2.11.2", meta },
        },
      }),
  });
  expect(await transport(command)).toMatchObject({ api_version: "2.11.2", meta });
});

it("aborts a caller-owned wait without replay or remote process cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    signal: controller.signal,
    fetch: async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const pending = transport(command);
  const outcome = expect(pending).rejects.toBeDefined();
  controller.abort();
  await outcome;
  expect(calls).toBe(1);
});

it("preserves structured HTTP failures rather than reporting an invalid envelope", async () => {
  const transport = createRestActionIoTransport({
    endpoint: "https://fixture.invalid",
    agentId: "agent",
    bearerToken: () => "token",
    fetch: async () =>
      Response.json(
        {
          success: false,
          code: "ACTION_OUTCOME_UNKNOWN",
          requestId: "http-request",
          error: {
            code: "ACTION_OUTCOME_UNKNOWN",
            message: "not copied",
            details: { diagnostic_id: "diag", effects_possible: true, recovery: "query_execution" },
          },
        },
        { status: 503 },
      ),
  });
  await expect(transport(command)).rejects.toMatchObject({
    code: "ACTION_OUTCOME_UNKNOWN",
    outcomeUnknown: true,
    details: { diagnostic_id: "diag", recovery: "query_execution", request_id: "http-request" },
  });
});
