import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock("../../../../src/shared/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  publishConsumerSocketEvent,
  registerConsumerSocketEventHandler,
} from "../../../../src/application/services/consumer_socket_event_sink";

const minimalPublishInput = () =>
  ({
    eventId: "e1",
    eventName: "client:custom.test.ev",
    emittedAt: new Date().toISOString(),
    publisher: { principalType: "client" as const, clientId: "client-1" },
    payload: {},
    attachments: [],
  }) as const;

describe("publishConsumerSocketEvent", () => {
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    warnMock.mockClear();
  });

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it("returns zero recipients and logs warn once when handler is not registered", async () => {
    const r1 = await publishConsumerSocketEvent(minimalPublishInput());
    expect(r1.recipients).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toBe("consumer_socket_event_publish_sink_missing");
    expect(warnMock.mock.calls[0]?.[1]).toMatchObject({
      eventName: "client:custom.test.ev",
      clientId: "client-1",
    });

    const r2 = await publishConsumerSocketEvent({
      ...minimalPublishInput(),
      eventId: "e2",
    });
    expect(r2.recipients).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("delegates to handler and does not warn when registered", async () => {
    disposers.push(
      registerConsumerSocketEventHandler({
        publish: async () => ({ recipients: 4 }),
      }),
    );
    warnMock.mockClear();
    const r = await publishConsumerSocketEvent(minimalPublishInput());
    expect(r.recipients).toBe(4);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("fans out across all registered handlers and sums recipients", async () => {
    disposers.push(
      registerConsumerSocketEventHandler({
        publish: async () => ({ recipients: 2 }),
      }),
    );
    disposers.push(
      registerConsumerSocketEventHandler({
        publish: async () => ({ recipients: 3 }),
      }),
    );

    const r = await publishConsumerSocketEvent(minimalPublishInput());
    expect(r.recipients).toBe(5);
  });

  it("warns again after handler was registered then cleared", async () => {
    await publishConsumerSocketEvent(minimalPublishInput());
    expect(warnMock).toHaveBeenCalledTimes(1);

    const dispose = registerConsumerSocketEventHandler({
      publish: async () => ({ recipients: 1 }),
    });
    dispose();

    warnMock.mockClear();
    await publishConsumerSocketEvent(minimalPublishInput());
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
