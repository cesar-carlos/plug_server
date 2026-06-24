import { describe, expect, it } from "vitest";

import {
  isAgentPhaseTimingsNegotiated,
  isClientRequestIdEchoNegotiated,
  isHealthPiggybackNegotiated,
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
});
