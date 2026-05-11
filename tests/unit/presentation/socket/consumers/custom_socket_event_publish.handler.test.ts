import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { AppError } from "../../../../../src/shared/errors/app_error";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

vi.mock("../../../../../src/application/services/client_socket_event_publish.service", () => ({
  executeClientSocketEventPublish: vi.fn(),
  assertClientSocketEventPublishInputWithinLimits: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/client_socket_event_publish_socket_rate_limiter", () => ({
  allowClientSocketEventPublishSocketAsync: vi.fn(),
  refundClientSocketEventPublishSocketAsync: vi.fn(),
}));

vi.mock("../../../../../src/shared/metrics/socket_consumer.metrics", () => ({
  noteCustomSocketEventPublishRejected: vi.fn(),
  noteCustomSocketEventPublishViaSocket: vi.fn(),
}));

vi.mock("../../../../../src/shared/utils/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { executeClientSocketEventPublish } from "../../../../../src/application/services/client_socket_event_publish.service";
import {
  allowClientSocketEventPublishSocketAsync,
  refundClientSocketEventPublishSocketAsync,
} from "../../../../../src/presentation/socket/hub/client_socket_event_publish_socket_rate_limiter";
import {
  handleCustomSocketEventPublish,
  shouldRefundSocketCustomEventPublishRateLimit,
} from "../../../../../src/presentation/socket/consumers/custom_socket_event_publish.handler";
import {
  noteCustomSocketEventPublishRejected,
  noteCustomSocketEventPublishViaSocket,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";
import { logger } from "../../../../../src/shared/utils/logger";
import { assertClientSocketEventPublishInputWithinLimits } from "../../../../../src/application/services/client_socket_event_publish.service";
import { env } from "../../../../../src/shared/config/env";

const mockedExecute = vi.mocked(executeClientSocketEventPublish);
const mockedAssertLimits = vi.mocked(assertClientSocketEventPublishInputWithinLimits);
const mockedAllow = vi.mocked(allowClientSocketEventPublishSocketAsync);
const mockedRefund = vi.mocked(refundClientSocketEventPublishSocketAsync);
const mockedNoteViaSocket = vi.mocked(noteCustomSocketEventPublishViaSocket);
const mockedNoteRejected = vi.mocked(noteCustomSocketEventPublishRejected);
const mockedLoggerWarn = vi.mocked(logger.warn);

const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(() => resolve());
  });
};

const buildClientSocket = (): Socket =>
  ({
    id: "sock-1",
    connected: true,
    data: {
      user: {
        sub: "client-sub-xyz",
        principal_type: "client",
        role: "client",
      },
    },
    emit: vi.fn(),
  }) as unknown as Socket;

const validPublishPayload = {
  requestId: "req-handler-1",
  eventName: "client:custom.handler.unit",
  payload: { n: 1 },
};

describe("shouldRefundSocketCustomEventPublishRateLimit", () => {
  it("returns false for idempotency conflict", () => {
    expect(
      shouldRefundSocketCustomEventPublishRateLimit(
        new AppError("conflict", { statusCode: 409, code: "IDEMPOTENCY_KEY_CONFLICT" }),
      ),
    ).toBe(false);
  });

  it("returns false for other 4xx", () => {
    expect(
      shouldRefundSocketCustomEventPublishRateLimit(
        new AppError("bad", { statusCode: 400, code: "VALIDATION_ERROR" }),
      ),
    ).toBe(false);
  });

  it("returns true for 503", () => {
    expect(
      shouldRefundSocketCustomEventPublishRateLimit(
        new AppError("unavailable", { statusCode: 503, code: "SERVICE_UNAVAILABLE" }),
      ),
    ).toBe(true);
  });

  it("returns true for non-AppError", () => {
    expect(shouldRefundSocketCustomEventPublishRateLimit(new Error("boom"))).toBe(true);
  });

  it("returns false for 429 AppError (execute path does not use this today; policy is no refund on 4xx)", () => {
    expect(
      shouldRefundSocketCustomEventPublishRateLimit(
        new AppError("busy", { statusCode: 429, code: "RATE_LIMITED" }),
      ),
    ).toBe(false);
  });
});

describe("handleCustomSocketEventPublish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAssertLimits.mockImplementation(() => undefined);
    mockedAllow.mockResolvedValue(true);
  });

  it("should not increment via_socket metric on idempotent replay", async () => {
    mockedExecute.mockResolvedValue({
      success: true,
      eventId: "e1",
      eventName: "client:custom.handler.unit",
      recipients: 0,
      idempotencyKey: "idem-1",
      idempotentReplay: true,
    });

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, {
      ...validPublishPayload,
      idempotencyKey: "idem-1",
    });

    await flushMicrotasks();

    expect(mockedNoteViaSocket).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventPublished,
      expect.objectContaining({ success: true, requestId: "req-handler-1" }),
    );
  });

  it("should increment via_socket metric on new emission", async () => {
    mockedExecute.mockResolvedValue({
      success: true,
      eventId: "e2",
      eventName: "client:custom.handler.unit",
      recipients: 1,
      idempotentReplay: false,
    });

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);

    await flushMicrotasks();

    expect(mockedNoteViaSocket).toHaveBeenCalledTimes(1);
  });

  it("should refund rate limit when execute fails with 503", async () => {
    mockedExecute.mockRejectedValue(
      new AppError("fan-out", { statusCode: 503, code: "SERVICE_UNAVAILABLE" }),
    );

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);

    await flushMicrotasks();

    expect(mockedRefund).toHaveBeenCalledWith("client-sub-xyz", 1);
    expect(mockedNoteRejected).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventPublished,
      expect.objectContaining({ success: false }),
    );
  });

  it("should not refund when execute fails with idempotency conflict", async () => {
    mockedExecute.mockRejectedValue(
      new AppError("conflict", { statusCode: 409, code: "IDEMPOTENCY_KEY_CONFLICT" }),
    );

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);

    await flushMicrotasks();

    expect(mockedRefund).not.toHaveBeenCalled();
  });

  it("should not refund when execute fails with 413", async () => {
    mockedExecute.mockRejectedValue(
      new AppError("too big", { statusCode: 413, code: "PAYLOAD_TOO_LARGE" }),
    );

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);

    await flushMicrotasks();

    expect(mockedRefund).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventPublished,
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 }),
      }),
    );
  });

  it("should emit original execute error when refund throws", async () => {
    mockedExecute.mockRejectedValue(
      new AppError("fan-out", { statusCode: 503, code: "SERVICE_UNAVAILABLE" }),
    );
    mockedRefund.mockRejectedValueOnce(new Error("refund failed"));

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);

    await flushMicrotasks();

    expect(mockedRefund).toHaveBeenCalledWith("client-sub-xyz", 1);
    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      "client_socket_event_publish_rate_limit_refund_failed",
      expect.objectContaining({ clientSub: "client-sub-xyz", message: "refund failed" }),
    );
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventPublished,
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "SERVICE_UNAVAILABLE", statusCode: 503 }),
      }),
    );
  });
});

describe("handleCustomSocketEventPublish dedicated inflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAssertLimits.mockImplementation(() => undefined);
    mockedAllow.mockResolvedValue(true);
  });

  afterEach(() => {
    (env as { socketCustomEventPublishMaxInflightPerSocket: number }).socketCustomEventPublishMaxInflightPerSocket = 0;
  });

  it("should reject second publish when dedicated cap is 1 and first is still in flight", () => {
    (env as { socketCustomEventPublishMaxInflightPerSocket: number }).socketCustomEventPublishMaxInflightPerSocket = 1;
    mockedExecute.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);
    handleCustomSocketEventPublish(socket, { ...validPublishPayload, requestId: "req-2" });

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventPublished,
      expect.objectContaining({
        success: false,
        requestId: "req-2",
        error: expect.objectContaining({
          code: "RATE_LIMITED",
          message: "Custom publish concurrent limit exceeded",
        }),
      }),
    );
  });

  it("should not emit published ack when socket is disconnected", async () => {
    mockedExecute.mockResolvedValue({
      success: true,
      eventId: "e3",
      eventName: "client:custom.handler.unit",
      recipients: 0,
      idempotentReplay: false,
    });

    const socket = buildClientSocket();
    handleCustomSocketEventPublish(socket, validPublishPayload);
    (socket as { connected: boolean }).connected = false;
    await flushMicrotasks();

    expect(socket.emit).not.toHaveBeenCalled();
  });
});
