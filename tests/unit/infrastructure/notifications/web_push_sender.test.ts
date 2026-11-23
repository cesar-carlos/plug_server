import { createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import https, { type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { generateVAPIDKeys } from "web-push";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { PwaPushSubscription } from "../../../../src/domain/ports/pwa_push.port";
import { WebPushSender } from "../../../../src/infrastructure/notifications/web_push_sender";

describe("WebPushSender real library compatibility", () => {
  afterEach(() => vi.restoreAllMocks());

  const subscription = (): PwaPushSubscription => {
    const key = createECDH("prime256v1");
    key.generateKeys();
    return {
      clientId: "client",
      installationId: "installation",
      endpoint: "https://fcm.googleapis.com/test-only",
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    };
  };
  const message = { eventId: "event", type: "access-approved" } as const;
  const sender = (): WebPushSender =>
    new WebPushSender({
      subject: "mailto:test@example.com",
      ...generateVAPIDKeys(),
    });

  const intercept = (
    status: number | "timeout",
  ): {
    transport: MockInstance<typeof https.request>;
    request: ClientRequest;
    options: () => RequestOptions | undefined;
    body: () => Buffer | undefined;
  } => {
    let options: RequestOptions | undefined;
    let body: Buffer | undefined;
    const request = new EventEmitter() as ClientRequest;
    request.write = vi.fn((chunk: Buffer) => {
      body = chunk;
      return true;
    });
    request.destroy = vi.fn((error?: Error) => {
      queueMicrotask(() => request.emit("error", error));
      return request;
    });
    const transport = vi.spyOn(https, "request").mockImplementation(((
      opts: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      options = opts;
      request.end = vi.fn(() => {
        queueMicrotask(() => {
          if (status === "timeout") {
            request.emit("timeout");
            return;
          }
          const response = Readable.from([]) as IncomingMessage;
          response.statusCode = status;
          response.headers = {};
          callback(response);
        });
        return request;
      });
      return request;
    }) as typeof https.request);
    return { transport, request, options: () => options, body: () => body };
  };

  it("sends encrypted payloads through web-push 4 named exports", async () => {
    const transport = intercept(201);
    await expect(sender().send(subscription(), message)).resolves.toBe("sent");
    expect(transport.transport).toHaveBeenCalledOnce();
    expect(transport.options()).toMatchObject({ timeout: 10_000 });
    expect(transport.body()).toBeInstanceOf(Buffer);
    expect(transport.body()!.length).toBeGreaterThan(JSON.stringify(message).length);
    expect(transport.body()!.includes(Buffer.from(JSON.stringify(message)))).toBe(false);
  });

  it.each([
    [404, "expired"],
    [410, "expired"],
    [429, "retry"],
    [500, "retry"],
  ] as const)(
    "classifies provider status %i as %s using the actual WebPushError",
    async (status, outcome) => {
      intercept(status);
      await expect(sender().send(subscription(), message)).resolves.toBe(outcome);
    },
  );

  it("destroys a timed out request and returns retry", async () => {
    const transport = intercept("timeout");
    await expect(sender().send(subscription(), message)).resolves.toBe("retry");
    expect(transport.request.destroy).toHaveBeenCalledOnce();
  });

  it("rejects disallowed endpoints before opening a connection", async () => {
    const transport = intercept(201);
    await expect(
      sender().send({ ...subscription(), endpoint: "https://127.0.0.1/" }, message),
    ).resolves.toBe("expired");
    expect(transport.transport).not.toHaveBeenCalled();
  });
});
