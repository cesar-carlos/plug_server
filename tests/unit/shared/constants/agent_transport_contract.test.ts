import { describe, expect, it } from "vitest";

import {
  HUB_SERVER_CAPABILITIES,
  HUB_TRANSPORT_EXTENSIONS,
  buildHubServerCapabilities,
} from "../../../../src/shared/constants/agent_transport_contract";

describe("agent_transport_contract", () => {
  describe("HUB_TRANSPORT_EXTENSIONS", () => {
    it("advertises plug-jsonrpc-profile/2.9 (aligned with plug_agente OpenRPC 2.9.0)", () => {
      expect(HUB_TRANSPORT_EXTENSIONS.plugProfile).toBe("plug-jsonrpc-profile/2.9");
    });

    it("keeps the binary PayloadFrame and protocolReadyAck flags on", () => {
      expect(HUB_TRANSPORT_EXTENSIONS.binaryPayload).toBe(true);
      expect(HUB_TRANSPORT_EXTENSIONS.protocolReadyAck).toBe(true);
      expect(HUB_TRANSPORT_EXTENSIONS.transportFrame).toBe("payload-frame/1.0");
    });

    it("advertises PayloadFrame performance defaults aligned with plug_agente", () => {
      expect(HUB_TRANSPORT_EXTENSIONS.compressionThreshold).toBe(4096);
      expect(HUB_TRANSPORT_EXTENSIONS.maxInflationRatio).toBe(10);
    });
  });

  describe("buildHubServerCapabilities", () => {
    it("returns the static base capabilities when no hints are passed", () => {
      const caps = buildHubServerCapabilities();
      expect(caps.protocols).toEqual(HUB_SERVER_CAPABILITIES.protocols);
      expect(caps.encodings).toEqual(HUB_SERVER_CAPABILITIES.encodings);
      expect(caps.compressions).toEqual(HUB_SERVER_CAPABILITIES.compressions);
      expect(caps.limits).toEqual(HUB_SERVER_CAPABILITIES.limits);
      expect(caps.extensions).not.toHaveProperty("recommendedStreamPullWindowSize");
      expect(caps.extensions).not.toHaveProperty("maxStreamPullWindowSize");
    });

    it("merges stream pull window hints into extensions (rounded to >= 1)", () => {
      const caps = buildHubServerCapabilities({
        recommendedStreamPullWindowSize: 256,
        maxStreamPullWindowSize: 512,
      });
      expect(caps.extensions.recommendedStreamPullWindowSize).toBe(256);
      expect(caps.extensions.maxStreamPullWindowSize).toBe(512);
    });

    it("clamps fractional / non-positive hints to a minimum of 1", () => {
      const caps = buildHubServerCapabilities({
        recommendedStreamPullWindowSize: 0.4,
        maxStreamPullWindowSize: -7,
      });
      expect(caps.extensions.recommendedStreamPullWindowSize).toBe(1);
      expect(caps.extensions.maxStreamPullWindowSize).toBe(1);
    });

    it("clamps recommendedStreamPullWindowSize to maxStreamPullWindowSize", () => {
      const caps = buildHubServerCapabilities({
        recommendedStreamPullWindowSize: 1024,
        maxStreamPullWindowSize: 128,
      });

      expect(caps.extensions.recommendedStreamPullWindowSize).toBe(128);
      expect(caps.extensions.maxStreamPullWindowSize).toBe(128);
    });

    it("does not mutate the static HUB_TRANSPORT_EXTENSIONS object", () => {
      buildHubServerCapabilities({
        recommendedStreamPullWindowSize: 99,
        maxStreamPullWindowSize: 100,
      });
      expect(HUB_TRANSPORT_EXTENSIONS).not.toHaveProperty("recommendedStreamPullWindowSize");
      expect(HUB_TRANSPORT_EXTENSIONS).not.toHaveProperty("maxStreamPullWindowSize");
    });
  });
});
