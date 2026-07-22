import { describe, expect, it } from "vitest";

import { HUB_TRANSPORT_EXTENSIONS } from "../../../../src/shared/constants/agent_transport_contract";
import {
  isAgentPhaseTimingsNegotiated,
  isClientRequestIdEchoNegotiated,
  isHealthPiggybackNegotiated,
  isParallelBatchDispatchNegotiated,
  snapshotRelayRouteTransportFlags,
} from "../../../../src/shared/constants/transport_extension_negotiation";

describe("transport_extension_negotiation", () => {
  const negotiatedAgentCapabilities = {
    protocols: ["jsonrpc-v2"],
    extensions: {
      clientRequestIdEcho: "v1",
      agentPhaseTimings: "v1",
      healthPiggyback: {
        intervalRequests: 50,
        freshnessThresholdMs: 5000,
      },
    },
  };

  it("returns true when agent advertises matching clientRequestIdEcho", () => {
    expect(isClientRequestIdEchoNegotiated(negotiatedAgentCapabilities)).toBe(true);
  });

  it("returns false when agent omits clientRequestIdEcho", () => {
    expect(
      isClientRequestIdEchoNegotiated({
        protocols: ["jsonrpc-v2"],
        extensions: {},
      }),
    ).toBe(false);
  });

  it("returns true when agent advertises matching agentPhaseTimings", () => {
    expect(isAgentPhaseTimingsNegotiated(negotiatedAgentCapabilities)).toBe(true);
  });

  it("returns true when agent advertises healthPiggyback object", () => {
    expect(isHealthPiggybackNegotiated(negotiatedAgentCapabilities)).toBe(true);
  });

  it("snapshots relay route transport flags from agent capabilities", () => {
    expect(snapshotRelayRouteTransportFlags(negotiatedAgentCapabilities)).toEqual({
      clientRequestIdEcho: true,
      agentPhaseTimingsNegotiated: true,
      healthPiggybackNegotiated: true,
    });
    expect(snapshotRelayRouteTransportFlags({ extensions: {} })).toEqual({
      clientRequestIdEcho: false,
      agentPhaseTimingsNegotiated: false,
      healthPiggybackNegotiated: false,
    });
  });
});

describe("transport_extension_negotiation parallelBatchDispatch", () => {
  it("returns true when agent advertises parallelBatchDispatch.enabled", () => {
    expect(
      isParallelBatchDispatchNegotiated({
        extensions: {
          parallelBatchDispatch: {
            enabled: true,
            maxConcurrency: 4,
            mixedReadOnlyMethods: true,
            selectOnlySqlExecute: true,
          },
        },
      }),
    ).toBe(true);
  });

  it("returns false when agent omits parallelBatchDispatch", () => {
    expect(isParallelBatchDispatchNegotiated({ extensions: {} })).toBe(false);
  });

  it("returns false when agent disables parallelBatchDispatch", () => {
    expect(
      isParallelBatchDispatchNegotiated({
        extensions: { parallelBatchDispatch: { enabled: false } },
      }),
    ).toBe(false);
  });

  it("hub advertises enabled parallelBatchDispatch", () => {
    expect(HUB_TRANSPORT_EXTENSIONS.parallelBatchDispatch.enabled).toBe(true);
  });
});
