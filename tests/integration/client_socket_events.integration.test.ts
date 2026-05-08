import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { decodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { isRecord } from "../../src/shared/utils/rpc_types";
import { resetClientSocketEventPublishIdempotencyStore } from "../../src/presentation/http/services/client_socket_event_idempotency_store";

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

const waitForNoEvent = async (
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  timeoutMs = 250,
): Promise<void> => {
  await expect(waitForEvent(socket, eventName, timeoutMs)).rejects.toThrow(/Timed out/);
};

const subscribe = async (
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  requestId: string,
): Promise<void> => {
  const ackPromise = waitForEvent<{
    success: boolean;
    requestId: string;
    data?: { eventName: string; subscribed: boolean };
    error?: { message: string };
  }>(socket, socketEvents.socketEventSubscribed);
  socket.emit(socketEvents.socketEventSubscribe, { requestId, eventName });
  const ack = await ackPromise;
  expect(ack).toMatchObject({
    success: true,
    requestId,
    data: { eventName, subscribed: true },
  });
};

const unsubscribe = async (
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  requestId: string,
): Promise<void> => {
  const ackPromise = waitForEvent<{
    success: boolean;
    requestId: string;
    data?: { eventName: string; subscribed: boolean };
  }>(socket, socketEvents.socketEventUnsubscribed);
  socket.emit(socketEvents.socketEventUnsubscribe, { requestId, eventName });
  const ack = await ackPromise;
  expect(ack).toMatchObject({
    success: true,
    requestId,
    data: { eventName, subscribed: false },
  });
};

const decodeCustomEventFrame = (rawFrame: unknown): Record<string, unknown> => {
  const decoded = decodePayloadFrame(rawFrame);
  if (!decoded.ok || !isRecord(decoded.value.data)) {
    throw new Error("Invalid custom event PayloadFrame");
  }
  return decoded.value.data;
};

describe("Client REST socket event pub/sub", () => {
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
    await server.close();
  });

  it("should publish JSON to all subscribed consumers and skip non-subscribers", async () => {
    const session = await registerOwnerAndClientSession(server.httpServer, {
      suffix: "socket-events-json",
    });
    const eventName = "client:custom.status.changed";
    const subscriberA = await connectConsumer(server.getUrl(), session.client.accessToken);
    const subscriberB = await connectConsumer(server.getUrl(), session.client.accessToken);
    const outsider = await connectConsumer(server.getUrl(), session.client.accessToken);
    sockets.push(subscriberA, subscriberB, outsider);

    await subscribe(subscriberA, eventName, "sub-a");
    await subscribe(subscriberB, eventName, "sub-b");

    const eventA = waitForEvent<unknown>(subscriberA, eventName);
    const eventB = waitForEvent<unknown>(subscriberB, eventName);
    const noOutsiderEvent = waitForNoEvent(outsider, eventName);

    const response = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({
        eventName,
        payloadFrameCompression: "default",
        payload: { status: "ready", count: 2 },
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      eventName,
      recipients: 2,
    });

    const payloadA = decodeCustomEventFrame(await eventA);
    const payloadB = decodeCustomEventFrame(await eventB);
    expect(payloadA.payload).toEqual({ status: "ready", count: 2 });
    expect(payloadB.payload).toEqual({ status: "ready", count: 2 });
    expect(payloadA.publisher).toEqual({
      principalType: "client",
      clientId: session.client.clientId,
    });
    await noOutsiderEvent;
  });

  it("should stop delivery after unsubscribe and accept zero-recipient publishes", async () => {
    const session = await registerOwnerAndClientSession(server.httpServer, {
      suffix: "socket-events-unsub",
    });
    const eventName = "client:custom.unsubscribed";
    const socket = await connectConsumer(server.getUrl(), session.client.accessToken);
    sockets.push(socket);

    await subscribe(socket, eventName, "sub-once");
    await unsubscribe(socket, eventName, "unsub-once");
    const noEvent = waitForNoEvent(socket, eventName);

    const response = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({ eventName, payload: { ignored: true } });

    expect(response.status).toBe(202);
    expect(response.body.recipients).toBe(0);
    await noEvent;
  });

  it("should publish multipart attachments inline", async () => {
    const session = await registerOwnerAndClientSession(server.httpServer, {
      suffix: "socket-events-multipart",
    });
    const eventName = "client:custom.document.ready";
    const socket = await connectConsumer(server.getUrl(), session.client.accessToken);
    sockets.push(socket);
    await subscribe(socket, eventName, "sub-multipart");

    const eventPromise = waitForEvent<unknown>(socket, eventName);
    const response = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .field(
        "event",
        JSON.stringify({
          eventName,
          payloadFrameCompression: "none",
          payload: { documentId: "doc-1" },
        }),
      )
      .attach("files", Buffer.from("hello"), {
        filename: "hello.txt",
        contentType: "text/plain",
      });

    expect(response.status).toBe(202);
    expect(response.body.recipients).toBe(1);

    const payload = decodeCustomEventFrame(await eventPromise);
    expect(payload.payload).toEqual({ documentId: "doc-1" });
    expect(payload.attachments).toEqual([
      {
        fieldName: "files",
        originalName: "hello.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        base64: Buffer.from("hello").toString("base64"),
      },
    ]);
  });

  it("should replay idempotent REST publish responses without emitting duplicates", async () => {
    const session = await registerOwnerAndClientSession(server.httpServer, {
      suffix: "socket-events-idempotency",
    });
    const eventName = "client:custom.idempotent";
    const socket = await connectConsumer(server.getUrl(), session.client.accessToken);
    sockets.push(socket);
    await subscribe(socket, eventName, "sub-idempotent");

    const eventPromise = waitForEvent<unknown>(socket, eventName);
    const first = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "idem-socket-event-1")
      .send({ eventName, payload: { count: 1 } });

    expect(first.status).toBe(202);
    expect(first.body.idempotentReplay).toBe(false);
    expect(decodeCustomEventFrame(await eventPromise).payload).toEqual({ count: 1 });

    const noDuplicateEvent = waitForNoEvent(socket, eventName);
    const replay = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "idem-socket-event-1")
      .send({ eventName, payload: { count: 1 } });

    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      eventId: first.body.eventId,
      eventName,
      recipients: first.body.recipients,
      idempotencyKey: "idem-socket-event-1",
      idempotentReplay: true,
    });
    await noDuplicateEvent;

    const conflict = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .set("Idempotency-Key", "idem-socket-event-1")
      .send({ eventName, payload: { count: 2 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("should reject non-client tokens and internal event names", async () => {
    const session = await registerOwnerAndClientSession(server.httpServer, {
      suffix: "socket-events-reject",
    });

    const forbidden = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.owner.accessToken}`)
      .send({ eventName: "client:custom.status", payload: {} });
    expect(forbidden.status).toBe(403);

    const invalid = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({ eventName: "relay:rpc.request", payload: {} });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");

    const missingPayload = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({ eventName: "client:custom.status" });
    expect(missingPayload.status).toBe(400);

    const unexpectedFileField = await request(server.httpServer)
      .post("/api/v1/client/me/socket-events")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .field(
        "event",
        JSON.stringify({ eventName: "client:custom.status", payload: { ok: true } }),
      )
      .attach("upload", Buffer.from("hello"), {
        filename: "hello.txt",
        contentType: "text/plain",
      });
    expect(unexpectedFileField.status).toBe(400);
  });
});
