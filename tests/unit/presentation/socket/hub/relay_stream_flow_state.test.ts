import { afterEach, describe, expect, it } from "vitest";

import {
  clearRelayStreamFlowState,
  relayStreamFlowState,
  resetRelayStreamFlowState,
} from "../../../../../src/presentation/socket/hub/relay_stream_flow_state";

afterEach(() => {
  resetRelayStreamFlowState();
});

describe("relay_stream_flow_state", () => {
  it("clearRelayStreamFlowState subtracts buffered length from total", () => {
    relayStreamFlowState.bufferedChunksByRequestId.set("r1", [{ a: 1 }, { b: 2 }]);
    relayStreamFlowState.totalBufferedChunks = 2;

    clearRelayStreamFlowState("r1");

    expect(relayStreamFlowState.bufferedChunksByRequestId.has("r1")).toBe(false);
    expect(relayStreamFlowState.totalBufferedChunks).toBe(0);
  });

  it("resetRelayStreamFlowState clears maps and total", () => {
    relayStreamFlowState.creditsByRequestId.set("r1", 3);
    relayStreamFlowState.pendingCompleteByRequestId.set("r1", {});
    relayStreamFlowState.totalBufferedChunks = 5;

    resetRelayStreamFlowState();

    expect(relayStreamFlowState.creditsByRequestId.size).toBe(0);
    expect(relayStreamFlowState.pendingCompleteByRequestId.size).toBe(0);
    expect(relayStreamFlowState.totalBufferedChunks).toBe(0);
  });
});
