import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import { expect, it } from "vitest";
import { ActionIoReferenceClient } from "../../docs/snippets/action_io_reference_client";
import { createSocketActionIoTransport } from "../../docs/snippets/action_io_socket_transport";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";

for (const relay of [false, true]) {
  it(`reference client uses real Socket.IO ${relay ? "relay" : "command"} framing`, async () => {
    const http = createServer();
    const server = new Server(http, { transports: ["websocket"] });
    const received: unknown[] = [];
    server.on("connection", (peer) => {
      peer.on(
        relay ? "relay:rpc.request" : "agents:command",
        (payload: Record<string, unknown>) => {
          const decoded = relay ? decodePayloadFrame(payload.frame) : null;
          const request = (
            relay ? (decoded?.ok ? decoded.value.data : undefined) : payload.command
          ) as {
            id: string;
            method: string;
            params: Record<string, unknown>;
          };
          received.push(request);
          const result = {
            execution_id: "e",
            message_id: "m",
            sequence: 0,
            state: "accepted",
            confirmed_bytes: 0,
            next_input_sequence: 1,
            stdin_state: "open",
          };
          peer.emit(
            relay ? "relay:rpc.response" : "agents:command_response",
            encodePayloadFrame(
              relay
                ? { jsonrpc: "2.0", id: request.id, result }
                : {
                    requestId: request.id,
                    response: { type: "single", item: { id: request.id, success: true, result } },
                  },
            ),
          );
        },
      );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const socket = io(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, {
      transports: ["websocket"],
      reconnection: false,
      retries: 2,
      ackTimeout: 20,
      autoConnect: false,
    });
    const transport = createSocketActionIoTransport({
      socket,
      agentId: "a",
      ...(relay ? { relayConversationId: "c" } : {}),
    });
    try {
      const connected = new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      socket.connect();
      await connected;
      const client = new ActionIoReferenceClient(transport, () => "isolated-test-credential");
      const send = (): Promise<Record<string, unknown>> =>
        client.sendInput("e", "m", 0, Uint8Array.from([0, 255, 13, 10, 26, 128]));
      const receipts = await Promise.race([
        Promise.all([send(), send()]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Concurrent send was dropped")), 1000),
        ),
      ]);
      expect(receipts.map((receipt) => receipt.state)).toEqual(["accepted", "accepted"]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({
        method: "agent.action.sendInput",
        params: {
          execution_id: "e",
          message_id: "m",
          sequence: 0,
          data_base64: "AP8NChqA",
        },
      });
    } finally {
      transport.dispose();
      socket.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
