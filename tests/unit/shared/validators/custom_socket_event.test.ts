import { describe, expect, it } from "vitest";

import {
  clientSocketEventPublishBodySchema,
  customSocketEventNameSchema,
  extractSocketEventRequestId,
  jsonUtf8ByteLength,
  jsonUtf8ByteLengthOrNull,
  socketEventPublishRequestSchema,
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

  it("should parse socket:event.publish request with optional idempotencyKey and attachments", () => {
    expect(
      socketEventPublishRequestSchema.parse({
        requestId: "req-1",
        idempotencyKey: "idem-1",
        eventName: "client:custom.socket.publish",
        payload: { n: 1 },
        attachments: [
          {
            fieldName: "files",
            originalName: "a.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            base64: Buffer.from("abc").toString("base64"),
          },
        ],
      }),
    ).toMatchObject({
      requestId: "req-1",
      idempotencyKey: "idem-1",
      eventName: "client:custom.socket.publish",
    });
  });

  it("should reject socket publish request without requestId", () => {
    const parsed = socketEventPublishRequestSchema.safeParse({
      eventName: "client:custom.x",
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("should extract only public-contract requestIds for error acks", () => {
    expect(extractSocketEventRequestId({ requestId: " req-1 " })).toBe("req-1");
    expect(extractSocketEventRequestId({ requestId: "" })).toBeUndefined();
    expect(extractSocketEventRequestId({ requestId: "r".repeat(129) })).toBeUndefined();
    expect(extractSocketEventRequestId({ requestId: 123 })).toBeUndefined();
  });

  it("should return null from jsonUtf8ByteLengthOrNull for circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(jsonUtf8ByteLengthOrNull(circular)).toBeNull();
  });
});
