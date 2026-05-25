import { afterEach, describe, expect, it } from "vitest";

import { validateAgentInboundContract } from "../../../../../src/presentation/socket/hub/agent_inbound_contract_validation";
import { env } from "../../../../../src/shared/config/env";
import { HUB_MAX_BATCH_SIZE } from "../../../../../src/shared/constants/agent_transport_contract";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../../src/shared/metrics/socket_agent.metrics";

const originalMode = env.socketAgentInboundContractValidation;

const setMode = (mode: "strict" | "warn" | "off"): void => {
  env.socketAgentInboundContractValidation = mode;
};

describe("agent inbound contract validation", () => {
  afterEach(() => {
    env.socketAgentInboundContractValidation = originalMode;
    resetSocketAgentMetrics();
  });

  it("accepts valid rpc:response and batch response payloads", () => {
    setMode("strict");

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcResponse,
        socketId: "agent-socket",
        payload: {
          jsonrpc: "2.0",
          id: "r1",
          result: { ok: true },
          api_version: "2.11",
          meta: {
            trace_id: "trace-1",
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            request_id: "r1",
            agent_id: "agent-1",
            timestamp: "2026-05-23T12:00:00.000Z",
          },
        },
      }).ok,
    ).toBe(true);

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcResponse,
        socketId: "agent-socket",
        payload: [
          { jsonrpc: "2.0", id: "b1", result: {} },
          { jsonrpc: "2.0", id: "b2", error: { code: -32000, message: "failed" } },
        ],
      }).ok,
    ).toBe(true);

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcResponse,
        socketId: "agent-socket",
        payload: Array.from({ length: HUB_MAX_BATCH_SIZE }, (_, index) => ({
          jsonrpc: "2.0",
          id: `batch-${index}`,
          result: {},
        })),
      }).ok,
    ).toBe(true);
  });

  it("rejects invalid rpc:response payloads in strict mode", () => {
    setMode("strict");

    const result = validateAgentInboundContract({
      eventName: socketEvents.rpcResponse,
      socketId: "agent-socket",
      payload: {
        jsonrpc: "2.0",
        id: "r1",
        result: {},
        error: { code: -32000, message: "failed" },
      },
    });

    expect(result).toEqual({
      ok: false,
      shouldProcess: false,
      message: "rpc:response must contain exactly one of result or error",
    });
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation.failedTotal).toBe(1);
  });

  it("rejects malformed rpc:response errors in strict mode", () => {
    setMode("strict");

    const missingCode = validateAgentInboundContract({
      eventName: socketEvents.rpcResponse,
      socketId: "agent-socket",
      payload: {
        jsonrpc: "2.0",
        id: "r1",
        error: { message: "failed" },
      },
    });
    expect(missingCode.ok).toBe(false);
    expect(missingCode.message).toBe("rpc:response error.code must be an integer");

    const missingMessage = validateAgentInboundContract({
      eventName: socketEvents.rpcResponse,
      socketId: "agent-socket",
      payload: {
        jsonrpc: "2.0",
        id: "r1",
        error: { code: -32000 },
      },
    });
    expect(missingMessage.ok).toBe(false);
    expect(missingMessage.message).toBe("rpc:response error.message must be a string");

    const invalidData = validateAgentInboundContract({
      eventName: socketEvents.rpcResponse,
      socketId: "agent-socket",
      payload: {
        jsonrpc: "2.0",
        id: "r1",
        error: { code: -32000, message: "failed", data: "not-object" },
      },
    });
    expect(invalidData.ok).toBe(false);
    expect(invalidData.message).toBe("rpc:response error.data must be an object");
  });

  it("rejects oversized rpc:response batches in strict mode", () => {
    setMode("strict");

    const result = validateAgentInboundContract({
      eventName: socketEvents.rpcResponse,
      socketId: "agent-socket",
      payload: Array.from({ length: HUB_MAX_BATCH_SIZE + 1 }, (_, index) => ({
        jsonrpc: "2.0",
        id: `batch-${index}`,
        result: {},
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(`rpc:response batch cannot exceed ${HUB_MAX_BATCH_SIZE}`);
  });

  it("warn mode records the failure but allows processing", () => {
    setMode("warn");

    const result = validateAgentInboundContract({
      eventName: socketEvents.rpcResponse,
      socketId: "agent-socket",
      payload: {
        jsonrpc: "2.0",
        id: "r1",
        result: {},
        meta: { extra: "not-published" },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.shouldProcess).toBe(true);
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation).toEqual({
      failedTotal: 1,
      warnTotal: 1,
    });
  });

  it("off mode skips validation and metrics", () => {
    setMode("off");

    const result = validateAgentInboundContract({
      eventName: socketEvents.rpcChunk,
      socketId: "agent-socket",
      payload: { not: "a chunk" },
    });

    expect(result).toEqual({ ok: true, shouldProcess: true });
    expect(getSocketAgentMetricsSnapshot().inboundContractValidation.failedTotal).toBe(0);
  });

  it("validates rpc:chunk required fields and rejects extra properties", () => {
    setMode("strict");

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcChunk,
        socketId: "agent-socket",
        payload: {
          stream_id: "stream-1",
          request_id: "req-1",
          chunk_index: 0,
          rows: [{ id: 1 }],
          total_chunks: 2,
          column_metadata: [{ name: "id" }],
        },
      }).ok,
    ).toBe(true);

    const invalid = validateAgentInboundContract({
      eventName: socketEvents.rpcChunk,
      socketId: "agent-socket",
      payload: {
        stream_id: "stream-1",
        request_id: "req-1",
        chunk_index: 0,
        rows: [],
        extra: true,
      },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.shouldProcess).toBe(false);
    expect(invalid.message).toBe("unexpected property extra");
  });

  it("validates rpc:complete required fields and types", () => {
    setMode("strict");

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcComplete,
        socketId: "agent-socket",
        payload: {
          stream_id: "stream-1",
          request_id: "req-1",
          total_rows: 2,
          affected_rows: 0,
          execution_id: "exec-1",
          started_at: "2026-05-23T12:00:00.000Z",
          finished_at: "2026-05-23T12:00:01.000Z",
        },
      }).ok,
    ).toBe(true);

    const invalid = validateAgentInboundContract({
      eventName: socketEvents.rpcComplete,
      socketId: "agent-socket",
      payload: {
        stream_id: "stream-1",
        request_id: "req-1",
        total_rows: -1,
      },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toBe("rpc:complete total_rows must be a non-negative integer");
  });

  it("validates request and batch ACK payloads", () => {
    setMode("strict");

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcRequestAck,
        socketId: "agent-socket",
        payload: { request_id: "req-1", received_at: "2026-05-23T12:00:00.000Z" },
      }).ok,
    ).toBe(true);
    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcBatchAck,
        socketId: "agent-socket",
        payload: {
          request_ids: Array.from({ length: HUB_MAX_BATCH_SIZE }, (_, index) => `req-${index}`),
        },
      }).ok,
    ).toBe(true);

    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcRequestAck,
        socketId: "agent-socket",
        payload: { request_id: {} },
      }).ok,
    ).toBe(false);
    expect(
      validateAgentInboundContract({
        eventName: socketEvents.rpcBatchAck,
        socketId: "agent-socket",
        payload: { request_ids: [] },
      }).ok,
    ).toBe(false);
    const oversizedBatchAck = validateAgentInboundContract({
      eventName: socketEvents.rpcBatchAck,
      socketId: "agent-socket",
      payload: {
        request_ids: Array.from(
          { length: HUB_MAX_BATCH_SIZE + 1 },
          (_, index) => `req-${index}`,
        ),
      },
    });
    expect(oversizedBatchAck.ok).toBe(false);
    if (!oversizedBatchAck.ok) {
      expect(oversizedBatchAck.message).toBe(
        `rpc:batch_ack request_ids cannot exceed ${HUB_MAX_BATCH_SIZE}`,
      );
    }
  });
});
