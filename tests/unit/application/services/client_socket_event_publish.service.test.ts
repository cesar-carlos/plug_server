import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertClientSocketEventPublishInputWithinLimits,
  executeClientSocketEventPublish,
} from "../../../../src/application/services/client_socket_event_publish.service";
import { env } from "../../../../src/shared/config/env";
import { resetClientSocketEventPublishIdempotencyStore } from "../../../../src/application/services/client_socket_event_idempotency_store";
import * as consumerSocketEventSink from "../../../../src/application/services/consumer_socket_event_sink";

vi.spyOn(consumerSocketEventSink, "publishConsumerSocketEvent").mockResolvedValue({ recipients: 2 });

describe("executeClientSocketEventPublish", () => {
  beforeEach(() => {
    resetClientSocketEventPublishIdempotencyStore();
    vi.mocked(consumerSocketEventSink.publishConsumerSocketEvent).mockClear();
  });

  it("should replay idempotent publishes without calling sink twice", async () => {
    const body = {
      eventName: "client:custom.unit.idem",
      payload: { n: 1 },
      attachments: [] as const,
    };

    const first = await executeClientSocketEventPublish({
      clientId: "client-sub-1",
      body,
      idempotencyKey: "unit-idem-1",
    });
    expect(first.idempotentReplay).toBe(false);
    expect(first.recipients).toBe(2);

    const second = await executeClientSocketEventPublish({
      clientId: "client-sub-1",
      body,
      idempotencyKey: "unit-idem-1",
    });
    expect(second.idempotentReplay).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(consumerSocketEventSink.publishConsumerSocketEvent).toHaveBeenCalledTimes(1);
  });

  it("should forward publishRequestId to the consumer socket event sink", async () => {
    const body = {
      eventName: "client:custom.unit.trace",
      payload: { ok: true },
      attachments: [] as const,
    };
    await executeClientSocketEventPublish({
      clientId: "client-sub-trace",
      body,
      publishRequestId: "pub-req-trace-1",
    });
    expect(consumerSocketEventSink.publishConsumerSocketEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        publishRequestId: "pub-req-trace-1",
      }),
    );
  });
});

describe("assertClientSocketEventPublishInputWithinLimits", () => {
  it("should reject JSON payload larger than REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES", () => {
    const pad = "p".repeat(env.restSocketEventPayloadJsonMaxBytes + 1);
    expect(() =>
      assertClientSocketEventPublishInputWithinLimits({
        eventName: "client:custom.payload.too.big",
        payload: { pad },
        attachments: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
      }),
    );
  });

  it("should reject more attachments than REST_SOCKET_EVENT_MAX_FILES", () => {
    const oneByteB64 = Buffer.from([0]).toString("base64");
    const attachments = Array.from({ length: env.restSocketEventMaxFiles + 1 }, (_, i) => ({
      fieldName: "files",
      originalName: `f${i}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      base64: oneByteB64,
    }));
    expect(() =>
      assertClientSocketEventPublishInputWithinLimits({
        eventName: "client:custom.attach.count",
        payload: {},
        attachments,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
      }),
    );
  });

  it("should reject attachment when base64 decoded length does not match sizeBytes", () => {
    expect(() =>
      assertClientSocketEventPublishInputWithinLimits({
        eventName: "client:custom.attach.b64",
        payload: {},
        attachments: [
          {
            fieldName: "files",
            originalName: "x.bin",
            mimeType: "application/octet-stream",
            sizeBytes: 99,
            base64: Buffer.from([1, 2]).toString("base64"),
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
      }),
    );
  });
});
