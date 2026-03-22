import { describe, expect, it } from "vitest";

import {
  applyPrivacyToBridgeLatencyRow,
  type BridgeLatencyTraceRowInput,
} from "../../../../src/application/services/bridge_latency_trace.service";

const baseRow = (): BridgeLatencyTraceRowInput => ({
  id: "id-1",
  channel: "rest",
  requestId: "req-very-long-correlation-value",
  traceId: null,
  agentId: "agent-1",
  userId: "user-secret",
  jsonRpcMethod: "sql.execute",
  totalMs: 10,
  phasesSumMs: 10,
  phasesSchemaVersion: 1,
  phasesMs: {},
  outcome: "success",
  httpStatus: 200,
  errorCode: null,
});

describe("applyPrivacyToBridgeLatencyRow", () => {
  it("passes through when redact off and truncate 0", () => {
    const row = baseRow();
    expect(applyPrivacyToBridgeLatencyRow(row, { redactUserId: false, truncateRequestIdChars: 0 })).toEqual(row);
  });

  it("truncates requestId when truncate > 0", () => {
    const row = baseRow();
    const out = applyPrivacyToBridgeLatencyRow(row, { redactUserId: false, truncateRequestIdChars: 8 });
    expect(out.requestId).toBe("req-very");
    expect(out.userId).toBe("user-secret");
  });

  it("nulls userId when redact on", () => {
    const row = baseRow();
    const out = applyPrivacyToBridgeLatencyRow(row, { redactUserId: true, truncateRequestIdChars: 0 });
    expect(out.userId).toBeNull();
    expect(out.requestId).toBe(row.requestId);
  });
});
