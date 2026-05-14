import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertClientSocketEventPublishInputWithinLimits,
  executeClientSocketEventPublish,
} from "../../../../src/application/services/client_socket_event_publish.service";
import { env } from "../../../../src/shared/config/env";
import {
  buildClientSocketEventPublishFingerprint,
  resetClientSocketEventPublishIdempotencyStore,
} from "../../../../src/application/services/client_socket_event_idempotency_store";
import { resetClientSocketEventPublishIdempotencySerializationQueues } from "../../../../src/application/services/client_socket_event_publish_idempotency_serialization";
import {
  registerClientSocketEventPublishDistributedIdempotencyStore,
  type ClientSocketEventPublishDistributedIdempotencyStore,
} from "../../../../src/application/services/client_socket_event_publish_distributed_idempotency";
import * as consumerSocketEventSink from "../../../../src/application/services/consumer_socket_event_sink";
import * as socketConsumerMetrics from "../../../../src/shared/metrics/socket_consumer.metrics";

vi.spyOn(consumerSocketEventSink, "publishConsumerSocketEvent").mockResolvedValue({
  recipients: 2,
});

describe("executeClientSocketEventPublish", () => {
  beforeEach(() => {
    resetClientSocketEventPublishIdempotencyStore();
    resetClientSocketEventPublishIdempotencySerializationQueues();
    registerClientSocketEventPublishDistributedIdempotencyStore(undefined);
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

  it("serializes concurrent publishes with the same idempotency key so sink emits once", async () => {
    const body = {
      eventName: "client:custom.concurrent.idem",
      payload: { n: 1 },
      attachments: [] as const,
    };
    let release!: (value: { recipients: number }) => void;
    const gate = new Promise<{ recipients: number }>((resolve) => {
      release = resolve;
    });
    vi.mocked(consumerSocketEventSink.publishConsumerSocketEvent).mockReturnValueOnce(gate);

    const first = executeClientSocketEventPublish({
      clientId: "client-concurrent",
      body,
      idempotencyKey: "idem-concurrent-1",
    });
    const second = executeClientSocketEventPublish({
      clientId: "client-concurrent",
      body,
      idempotencyKey: "idem-concurrent-1",
    });

    await vi.waitFor(() => {
      expect(consumerSocketEventSink.publishConsumerSocketEvent).toHaveBeenCalledTimes(1);
    });
    release({ recipients: 7 });

    const [a, b] = await Promise.all([first, second]);
    expect(consumerSocketEventSink.publishConsumerSocketEvent).toHaveBeenCalledTimes(1);
    const replay = a.idempotentReplay ? a : b;
    const fresh = a.idempotentReplay ? b : a;
    expect(fresh.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.eventId).toBe(fresh.eventId);
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

  it("rejects non-fingerprintable body when idempotency key is set", async () => {
    const spyRejected = vi.spyOn(socketConsumerMetrics, "noteCustomSocketEventPublishRejected");
    const body = {
      eventName: "client:custom.fp.bigint",
      payload: { x: BigInt(1) } as unknown,
      attachments: [] as const,
    };
    await expect(
      executeClientSocketEventPublish({
        clientId: "client-fp",
        body,
        idempotencyKey: "idem-fp-1",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(consumerSocketEventSink.publishConsumerSocketEvent).not.toHaveBeenCalled();
    expect(spyRejected).toHaveBeenCalledTimes(1);
    spyRejected.mockRestore();
  });

  it("records publish rejected once when sink rejects", async () => {
    const spyRejected = vi.spyOn(socketConsumerMetrics, "noteCustomSocketEventPublishRejected");
    vi.mocked(consumerSocketEventSink.publishConsumerSocketEvent).mockRejectedValueOnce(
      new Error("sink down"),
    );
    const body = {
      eventName: "client:custom.unit.sink.fail",
      payload: { n: 1 },
      attachments: [] as const,
    };
    await expect(
      executeClientSocketEventPublish({
        clientId: "client-sink-fail",
        body,
      }),
    ).rejects.toThrow("sink down");
    expect(spyRejected).toHaveBeenCalledTimes(1);
    spyRejected.mockRestore();
  });

  it("should replay from distributed idempotency store without emitting locally", async () => {
    const body = {
      eventName: "client:custom.distributed.replay",
      payload: { n: 1 },
      attachments: [] as const,
    };
    const store: ClientSocketEventPublishDistributedIdempotencyStore = {
      getEntry: vi.fn().mockResolvedValue({
        fingerprint: buildClientSocketEventPublishFingerprint(body),
        response: {
          success: true,
          eventId: "distributed-event-id",
          eventName: "client:custom.distributed.replay",
          recipients: 9,
        },
        expiresAtMs: Date.now() + 60_000,
      }),
      setEntry: vi.fn(),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
    };
    registerClientSocketEventPublishDistributedIdempotencyStore(store);

    const outcome = await executeClientSocketEventPublish({
      clientId: "client-distributed",
      body,
      idempotencyKey: "idem-distributed-replay",
    });

    expect(outcome).toMatchObject({
      eventId: "distributed-event-id",
      recipients: 9,
      idempotentReplay: true,
    });
    expect(consumerSocketEventSink.publishConsumerSocketEvent).not.toHaveBeenCalled();
  });

  it("should use distributed lock before first idempotent emit", async () => {
    const store: ClientSocketEventPublishDistributedIdempotencyStore = {
      getEntry: vi.fn().mockResolvedValue(undefined),
      setEntry: vi.fn().mockResolvedValue(undefined),
      acquireLock: vi.fn().mockResolvedValue("lock-token"),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    registerClientSocketEventPublishDistributedIdempotencyStore(store);

    const outcome = await executeClientSocketEventPublish({
      clientId: "client-distributed-lock",
      body: {
        eventName: "client:custom.distributed.lock",
        payload: { n: 1 },
        attachments: [],
      },
      idempotencyKey: "idem-distributed-lock",
    });

    expect(outcome.idempotentReplay).toBe(false);
    expect(store.acquireLock).toHaveBeenCalledWith(
      "client-distributed-lock",
      "idem-distributed-lock",
      env.restSocketEventIdempotencyRedisLockTtlMs,
    );
    expect(store.setEntry).toHaveBeenCalledOnce();
    expect(store.releaseLock).toHaveBeenCalledWith(
      "client-distributed-lock",
      "idem-distributed-lock",
      "lock-token",
    );
  });

  it("should release distributed lock when replay appears after lock acquisition", async () => {
    const body = {
      eventName: "client:custom.distributed.after-lock",
      payload: { n: 1 },
      attachments: [] as const,
    };
    const store: ClientSocketEventPublishDistributedIdempotencyStore = {
      getEntry: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          fingerprint: buildClientSocketEventPublishFingerprint(body),
          response: {
            success: true,
            eventId: "distributed-after-lock-event",
            eventName: body.eventName,
            recipients: 4,
          },
          expiresAtMs: Date.now() + 60_000,
        }),
      setEntry: vi.fn(),
      acquireLock: vi.fn().mockResolvedValue("after-lock-token"),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    registerClientSocketEventPublishDistributedIdempotencyStore(store);

    const outcome = await executeClientSocketEventPublish({
      clientId: "client-distributed-after-lock",
      body,
      idempotencyKey: "idem-distributed-after-lock",
    });

    expect(outcome.idempotentReplay).toBe(true);
    expect(outcome.eventId).toBe("distributed-after-lock-event");
    expect(consumerSocketEventSink.publishConsumerSocketEvent).not.toHaveBeenCalled();
    expect(store.releaseLock).toHaveBeenCalledWith(
      "client-distributed-after-lock",
      "idem-distributed-after-lock",
      "after-lock-token",
    );
  });

  it("should fall back to local idempotency when distributed lock command fails", async () => {
    const store: ClientSocketEventPublishDistributedIdempotencyStore = {
      getEntry: vi.fn().mockResolvedValue(undefined),
      setEntry: vi.fn().mockResolvedValue(undefined),
      acquireLock: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    registerClientSocketEventPublishDistributedIdempotencyStore(store);

    const outcome = await executeClientSocketEventPublish({
      clientId: "client-distributed-lock-fallback",
      body: {
        eventName: "client:custom.distributed.lock-fallback",
        payload: { n: 1 },
        attachments: [],
      },
      idempotencyKey: "idem-distributed-lock-fallback",
    });

    expect(outcome.idempotentReplay).toBe(false);
    expect(consumerSocketEventSink.publishConsumerSocketEvent).toHaveBeenCalledOnce();
    expect(store.setEntry).not.toHaveBeenCalled();
    expect(store.releaseLock).not.toHaveBeenCalled();
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

  it("should reject non-JSON-serializable payload (e.g. BigInt)", () => {
    expect(() =>
      assertClientSocketEventPublishInputWithinLimits({
        eventName: "client:custom.payload.bigint",
        payload: { x: BigInt(1) } as unknown,
        attachments: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
      }),
    );
  });
});
