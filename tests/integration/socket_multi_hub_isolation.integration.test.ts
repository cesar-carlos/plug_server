import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { decodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { isRecord } from "../../src/shared/utils/rpc_types";

const connectConsumer = (baseUrl: string, token: string): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
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

const waitForEvent = <T>(
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  timeoutMs = 4_000,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const onEvent = (payload: T): void => {
      clearTimeout(timeout);
      socket.off(eventName, onEvent);
      resolve(payload);
    };

    socket.on(eventName, onEvent);
  });

const subscribe = async (
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  requestId: string,
): Promise<void> => {
  const ackPromise = waitForEvent<{
    success: boolean;
    requestId: string;
    data?: { eventName: string; subscribed: boolean };
  }>(socket, socketEvents.socketEventSubscribed);
  socket.emit(socketEvents.socketEventSubscribe, { requestId, eventName });
  await expect(ackPromise).resolves.toMatchObject({
    success: true,
    requestId,
    data: expect.objectContaining({ eventName, subscribed: true }),
  });
};

const decodeCustomEventFrame = (rawFrame: unknown): Record<string, unknown> => {
  const decoded = decodePayloadFrame(rawFrame);
  if (!decoded.ok || !isRecord(decoded.value.data)) {
    throw new Error("Invalid custom event PayloadFrame");
  }
  return decoded.value.data;
};

describe("socket server instance isolation", () => {
  let serverA: TestServerResult;
  let serverB: TestServerResult;
  let serverAClosed = false;
  const sockets: ReturnType<typeof ioClient>[] = [];

  beforeAll(async () => {
    serverA = await createTestServer();
    serverB = await createTestServer();
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await serverB.close();
    if (!serverAClosed) {
      await serverA.close();
    }
  });

  it("keeps the second hub functional after the first hub is closed", async () => {
    const session = await registerOwnerAndClientSession(serverB.httpServer, {
      suffix: "multi-hub-isolation",
    });
    const socket = await connectConsumer(serverB.getUrl(), session.client.accessToken);
    sockets.push(socket);

    const eventName = "client:custom.multi.hub";
    await subscribe(socket, eventName, "multi-hub-sub");

    await serverA.close();
    serverAClosed = true;

    const eventPromise = waitForEvent<unknown>(socket, eventName);
    const response = await request(serverB.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({
        eventName,
        payload: { source: "server-b" },
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      eventName,
      recipients: 1,
    });
    expect(decodeCustomEventFrame(await eventPromise).payload).toEqual({ source: "server-b" });
  });
});
