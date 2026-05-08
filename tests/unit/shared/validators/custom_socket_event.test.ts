import { describe, expect, it } from "vitest";

import {
  clientSocketEventPublishBodySchema,
  customSocketEventNameSchema,
  jsonUtf8ByteLength,
  socketEventSubscriptionSchema,
} from "../../../../src/shared/validators/custom_socket_event";

describe("custom_socket_event validators", () => {
  it("should accept reserved client custom event names", () => {
    expect(customSocketEventNameSchema.parse("client:custom.status.changed")).toBe(
      "client:custom.status.changed",
    );
    expect(
      socketEventSubscriptionSchema.parse({
        requestId: "sub-1",
        eventName: "client:custom.document-ready_v2",
      }),
    ).toEqual({
      requestId: "sub-1",
      eventName: "client:custom.document-ready_v2",
    });
  });

  it("should reject internal protocol event names", () => {
    for (const eventName of [
      "agent:register",
      "agents:command",
      "relay:rpc.request",
      "rpc:request",
      "hub:heartbeat_ack",
      "connection:ready",
      "app:error",
      "client:agent.profile.updated",
      "socket:event.subscribe",
    ]) {
      expect(() => customSocketEventNameSchema.parse(eventName)).toThrow();
    }
  });

  it("should validate publish body and count UTF-8 JSON bytes", () => {
    const parsed = clientSocketEventPublishBodySchema.parse({
      eventName: "client:custom.status.changed",
      payloadFrameCompression: "always",
      payload: { ok: true },
    });

    expect(parsed.eventName).toBe("client:custom.status.changed");
    expect(jsonUtf8ByteLength(parsed.payload)).toBe(Buffer.byteLength('{"ok":true}', "utf8"));
  });

  it("should reject publish body without payload", () => {
    const parsed = clientSocketEventPublishBodySchema.safeParse({
      eventName: "client:custom.status.changed",
    });

    expect(parsed.success).toBe(false);
  });
});
