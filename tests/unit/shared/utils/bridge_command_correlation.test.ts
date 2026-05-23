import { describe, expect, it } from "vitest";

import {
  isBatchCommand,
  toCorrelationIds,
} from "../../../../src/shared/utils/bridge_command_correlation";

describe("bridge_command_correlation", () => {
  it("isBatchCommand and toCorrelationIds", () => {
    const single = { jsonrpc: "2.0" as const, method: "ping", id: "s1" };
    const batch = [
      { jsonrpc: "2.0" as const, method: "ping", id: "b1" },
      { jsonrpc: "2.0" as const, method: "ping", id: "b2" },
    ];

    expect(isBatchCommand(single)).toBe(false);
    expect(isBatchCommand(batch)).toBe(true);
    expect(toCorrelationIds(single)).toEqual(["s1"]);
    expect(toCorrelationIds(batch)).toEqual(["b1", "b2"]);
  });
});
