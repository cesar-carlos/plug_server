import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as EnvModule from "../../src/shared/config/env";
import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { decodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { resetClientSocketEventPublishIdempotencyStore } from "../../src/application/services/client_socket_event_idempotency_store";
import { resetClientSocketEventPublishIdempotencySerializationQueues } from "../../src/application/services/client_socket_event_publish_idempotency_serialization";
import { resetClientSocketEventPublishSocketRateLimitState } from "../../src/presentation/socket/hub/client_socket_event_publish_socket_rate_limiter";

vi.mock("../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketConsumerMaxInflightPerSocket: 1,
      socketCustomEventPublishMaxInflightPerSocket: 1,
    },
  };
});

const connectConsumer = (baseUrl: string, token: string): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token },
      transports: ["websocket"],
    });
    socket.on("connection:ready", (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        reject(new Error(`Failed to decode connection:ready: ${decoded.error.message}`));
        return;
      }
      resolve(socket);
    });
    socket.on("connect_error", (error) => reject(error));
  });

const waitForPublishedAck = (
  socket: ReturnType<typeof ioClient>,
  requestId: string,
  timeoutMs = 4_000,
): Promise<{
  success: boolean;
  requestId: string;
  error?: { code: string; message: string };
}> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(socketEvents.socketEventPublished, onPublished);
      reject(new Error(`Timed out waiting for socket:event.published (${requestId})`));
    }, timeoutMs);

    const onPublished = (ack: {
      success: boolean;
      requestId: string;
      error?: { code: string; message: string };
    }): void => {
      if (ack.requestId !== requestId) {
        return;
      }
      clearTimeout(timeout);
      socket.off(socketEvents.socketEventPublished, onPublished);
      resolve(ack);
    };

    socket.on(socketEvents.socketEventPublished, onPublished);
  });

describe("Client Socket socket:event.publish inflight gate", () => {
  let server: TestServerResult;
  const sockets: ReturnType<typeof ioClient>[] = [];

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    resetClientSocketEventPublishIdempotencyStore();
    resetClientSocketEventPublishIdempotencySerializationQueues();
    resetClientSocketEventPublishSocketRateLimitState();
    await server.close();
  });

  it("should reject concurrent publishes on the same socket with RATE_LIMITED when inflight cap is 1", async () => {
    const session = await registerOwnerAndClientSession(server.httpServer, {
      suffix: "socket-publish-inflight",
    });
    const eventName = "client:custom.inflight.concurrent";
    const socket = await connectConsumer(server.getUrl(), session.client.accessToken);
    sockets.push(socket);

    const ack1Promise = waitForPublishedAck(socket, "inflight-req-1");
    const ack2Promise = waitForPublishedAck(socket, "inflight-req-2");

    socket.emit(socketEvents.socketEventPublish, {
      requestId: "inflight-req-1",
      eventName,
      payload: { n: 1 },
    });
    socket.emit(socketEvents.socketEventPublish, {
      requestId: "inflight-req-2",
      eventName,
      payload: { n: 2 },
    });

    const results = await Promise.all([ack1Promise, ack2Promise]);
    const codes = results.map((r) => (r.success ? "OK" : r.error?.code)).sort();
    expect(codes).toContain("RATE_LIMITED");
    expect(codes).toContain("OK");
  });
});
