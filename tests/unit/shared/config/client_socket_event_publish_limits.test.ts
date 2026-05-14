import { describe, expect, it } from "vitest";

import {
  clientSocketEventPublishEnvelopeUtf8UpperBound,
  defaultRestSocketEventHttpJsonBodyLimit,
  formatExpressJsonBodyLimitMb,
  restSocketEventHttpJsonBodyMinBytes,
  socketEventPublishRawJsonUpperBound,
} from "../../../../src/shared/config/client_socket_event_publish_limits";

describe("client_socket_event_publish_limits", () => {
  it("computes envelope upper bound from payload + attachment budget", () => {
    const envelope = clientSocketEventPublishEnvelopeUtf8UpperBound(512 * 1024, 2 * 1024 * 1024);
    expect(envelope).toBe(
      512 * 1024 +
        Math.min(6 * 1024 * 1024, Math.ceil((2 * 1024 * 1024 * 4) / 3) + 512 * 1024) +
        64 * 1024,
    );
  });

  it("caps raw publish JSON by Engine.IO buffer", () => {
    const raw = socketEventPublishRawJsonUpperBound(
      10 * 1024 * 1024,
      10 * 1024 * 1024,
      10 * 1024 * 1024,
    );
    expect(raw).toBe(10 * 1024 * 1024);
  });

  it("formats express limit as whole mb", () => {
    expect(formatExpressJsonBodyLimitMb(1)).toBe("1mb");
    expect(formatExpressJsonBodyLimitMb(5 * 1024 * 1024)).toBe("5mb");
  });

  it("default HTTP JSON limit string covers envelope with headroom", () => {
    const s = defaultRestSocketEventHttpJsonBodyLimit(512 * 1024, 2 * 1024 * 1024);
    expect(s.endsWith("mb")).toBe(true);
    const envelope = clientSocketEventPublishEnvelopeUtf8UpperBound(512 * 1024, 2 * 1024 * 1024);
    const min = restSocketEventHttpJsonBodyMinBytes(512 * 1024, 2 * 1024 * 1024);
    expect(min).toBe(Math.ceil(envelope * 1.05));
  });
});
