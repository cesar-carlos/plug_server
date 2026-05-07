import { describe, expect, it } from "vitest";

import { normalizeAgentRpcResponse } from "../../../../../src/presentation/http/serializers/agent_rpc_response.serializer";
import { resolveAgentRpcRetryAfterSeconds } from "../../../../../src/presentation/http/serializers/agent_rpc_retry_after";

const buildSingleRateLimitResponse = (data: Record<string, unknown>): unknown =>
  normalizeAgentRpcResponse({
    jsonrpc: "2.0",
    id: "req-1",
    error: {
      code: -32013,
      message: "Rate limit exceeded",
      data: {
        reason: "client_token_get_policy_rate_limited",
        category: "transport",
        retryable: false,
        ...data,
      },
    },
  });

describe("resolveAgentRpcRetryAfterSeconds", () => {
  it("returns null when response is not a normalized envelope", () => {
    expect(resolveAgentRpcRetryAfterSeconds(null)).toBeNull();
    expect(resolveAgentRpcRetryAfterSeconds("not-an-object")).toBeNull();
    expect(
      resolveAgentRpcRetryAfterSeconds({ type: "raw", success: false, payload: {} }),
    ).toBeNull();
  });

  it("returns null when single response carries a non-rate-limit error", () => {
    const normalized = normalizeAgentRpcResponse({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: -32602,
        message: "Invalid params",
        data: { reason: "invalid_params", retry_after_ms: 5000 },
      },
    });
    expect(resolveAgentRpcRetryAfterSeconds(normalized)).toBeNull();
  });

  it("rounds `retry_after_ms` UP to seconds", () => {
    const normalized = buildSingleRateLimitResponse({ retry_after_ms: 1234 });
    expect(resolveAgentRpcRetryAfterSeconds(normalized)).toBe(2);
  });

  it("returns at least 1 second even for sub-1s windows", () => {
    const normalized = buildSingleRateLimitResponse({ retry_after_ms: 50 });
    expect(resolveAgentRpcRetryAfterSeconds(normalized)).toBe(1);
  });

  it("falls back to `reset_at` when `retry_after_ms` is absent", () => {
    const nowMs = Date.parse("2026-04-18T12:00:00.000Z");
    const resetAt = new Date(nowMs + 7_500).toISOString();
    const normalized = buildSingleRateLimitResponse({ reset_at: resetAt });
    expect(resolveAgentRpcRetryAfterSeconds(normalized, { nowMs })).toBe(8);
  });

  it("ignores `reset_at` already in the past", () => {
    const nowMs = Date.parse("2026-04-18T12:00:00.000Z");
    const normalized = buildSingleRateLimitResponse({
      reset_at: new Date(nowMs - 1000).toISOString(),
    });
    expect(resolveAgentRpcRetryAfterSeconds(normalized, { nowMs })).toBeNull();
  });

  it("picks the maximum hint across batch items", () => {
    const nowMs = Date.parse("2026-04-18T12:00:00.000Z");
    const normalized = normalizeAgentRpcResponse([
      {
        jsonrpc: "2.0",
        id: "q1",
        error: {
          code: -32013,
          message: "Rate limit exceeded",
          data: { reason: "rate_limited", retry_after_ms: 1500 },
        },
      },
      {
        jsonrpc: "2.0",
        id: "q2",
        result: { ok: true },
      },
      {
        jsonrpc: "2.0",
        id: "q3",
        error: {
          code: -32013,
          message: "Rate limit exceeded",
          data: { reason: "rate_limited", retry_after_ms: 4250 },
        },
      },
    ]);
    expect(resolveAgentRpcRetryAfterSeconds(normalized, { nowMs })).toBe(5);
  });

  it("returns null when rate-limit error has no usable hint", () => {
    const normalized = buildSingleRateLimitResponse({});
    expect(resolveAgentRpcRetryAfterSeconds(normalized)).toBeNull();
  });

  it("ignores negative `retry_after_ms`", () => {
    const normalized = buildSingleRateLimitResponse({ retry_after_ms: -1000 });
    expect(resolveAgentRpcRetryAfterSeconds(normalized)).toBeNull();
  });
});
