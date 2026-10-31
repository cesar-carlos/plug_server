import { afterEach, expect, it, vi } from "vitest";
import {
  createSocketActionIoTransport,
  type ActionIoSocket,
} from "../../../docs/snippets/action_io_socket_transport";
import { decodePayloadFrame, encodePayloadFrame } from "../../../src/shared/utils/payload_frame";

class SocketFixture implements ActionIoSocket {
  connected = true;
  io = { engine: { transport: { writable: true } } };
  get volatile(): this {
    return this;
  }
  listeners = new Map<string, Set<(value: unknown) => void>>();
  sent: Array<{ event: string; payload: unknown }> = [];
  on(event: string, listener: (value: unknown) => void): void {
    const values = this.listeners.get(event) ?? new Set();
    values.add(listener);
    this.listeners.set(event, values);
  }
  off(event: string, listener: (value: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, payload: unknown): void {
    this.sent.push({ event, payload });
  }
  receive(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}
const command = {
  jsonrpc: "2.0" as const,
  id: "request",
  method: "agent.action.sendInput",
  params: { execution_id: "e", message_id: "m", sequence: 0, data_base64: "AP8NGg==" },
};
const result = {
  execution_id: "e",
  message_id: "m",
  sequence: 0,
  state: "unknown",
  confirmed_bytes: null,
  next_input_sequence: 1,
  stdin_state: "failed",
};
afterEach(() => vi.useRealTimers());
it("correlates a relay preflight refusal and avoids waiting for an RPC response", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({
    socket,
    agentId: "a",
    relayConversationId: "c",
  });
  try {
    const pending = transport(command);
    const refusal = {
      success: false,
      clientRequestId: command.id,
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        details: { effects_possible: false, reason: "not_advertised" },
      },
    };
    socket.receive("relay:rpc.accepted", {
      ...refusal,
      conversationId: "other",
      error: { code: "OTHER" },
    });
    socket.receive("relay:rpc.accepted", { ...refusal, conversationId: "c" });
    await expect(pending).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      outcomeUnknown: false,
      details: { reason: "not_advertised" },
    });
    expect(socket.sent).toHaveLength(1);
  } finally {
    transport.dispose();
  }
  expect(socket.listeners.get("relay:rpc.accepted")?.size).toBe(0);
});
it("preserves hub failure reconciliation instead of replacing it with an envelope error", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  try {
    const pending = transport(command);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
      details: { diagnostic_id: "diag", recovery: "query_execution", request_id: command.id },
    });
    socket.receive(
      "agents:command_response",
      encodePayloadFrame({
        success: false,
        requestId: command.id,
        error: {
          code: "ACTION_OUTCOME_UNKNOWN",
          details: {
            diagnostic_id: "diag",
            recovery: "query_execution",
            effects_possible: true,
            payload: "private",
          },
        },
      }),
    );
    await assertion;
    expect(socket.sent).toHaveLength(1);
  } finally {
    transport.dispose();
  }
});
for (const relay of [false, true]) {
  it(`preserves binary requests and unknown receipts over ${relay ? "relay" : "socket"}`, async () => {
    const socket = new SocketFixture();
    const transport = createSocketActionIoTransport({
      socket,
      agentId: "a",
      ...(relay ? { relayConversationId: "c" } : {}),
    });
    try {
      const pending = transport(command);
      expect(socket.sent).toHaveLength(1);
      const sent = socket.sent[0]!.payload as Record<string, unknown>;
      if (relay) {
        const decoded = decodePayloadFrame(sent.frame);
        expect(decoded.ok && decoded.value.data).toEqual(command);
        expect(sent.conversationId).toBe("c");
      } else expect(sent.command).toEqual(command);
      const response = { jsonrpc: "2.0", id: command.id, result, meta: { trace_id: "trace" } };
      const envelope = relay
        ? response
        : {
            agentId: "a",
            response: {
              type: "single",
              item: {
                id: command.id,
                success: true,
                result,
                meta: response.meta,
              },
            },
          };
      socket.receive(
        relay ? "relay:rpc.response" : "agents:command_response",
        encodePayloadFrame(envelope),
      );
      expect(await pending).toEqual(response);
    } finally {
      transport.dispose();
    }
    expect([...socket.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
}
it("times out without replay and ignores unrelated correlations", async () => {
  vi.useFakeTimers();
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const pending = transport(command);
  const assertion = expect(pending).rejects.toMatchObject({
    code: "SOCKET_TIMEOUT",
    outcomeUnknown: true,
  });
  socket.receive(
    "agents:command_response",
    encodePayloadFrame({
      agentId: "a",
      response: { type: "single", item: { id: "other", success: true, result } },
    }),
  );
  await vi.advanceTimersByTimeAsync(30000);
  await assertion;
  expect(socket.sent).toHaveLength(1);
  transport.dispose();
});
it("disconnect rejects pending work but never reconnects or resends", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const pending = transport(command);
  socket.connected = false;
  socket.receive("disconnect", "transport close");
  await expect(pending).rejects.toMatchObject({
    code: "SOCKET_DISCONNECTED",
    outcomeUnknown: true,
  });
  await expect(transport({ ...command, id: "next" })).rejects.toMatchObject({
    code: "SOCKET_NOT_CONNECTED",
    outcomeUnknown: false,
  });
  expect(socket.sent).toHaveLength(1);
  transport.dispose();
});
it("dispose releases pending waits without closing the caller socket", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const pending = transport(command);
  transport.dispose();
  await expect(pending).rejects.toMatchObject({
    code: "SOCKET_TRANSPORT_DISPOSED",
    outcomeUnknown: true,
  });
  expect(socket.connected).toBe(true);
  expect(socket.sent).toHaveLength(1);
});
it("refuses oversized frames before decompression", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const pending = transport(command);
  socket.receive("agents:command_response", { originalSize: 1048577, compressedSize: 10 });
  await expect(pending).rejects.toMatchObject({ code: "INVALID_SOCKET_FRAME" });
  transport.dispose();
});

it("bounds pending requests independently of long-poll completion", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const requests = Array.from({ length: 32 }, (_, index) =>
    transport({ ...command, id: String(index) }),
  );
  const outcomes = Promise.allSettled(requests);
  await expect(transport({ ...command, id: "extra" })).rejects.toMatchObject({
    code: "SOCKET_CAPACITY",
    outcomeUnknown: false,
  });
  expect(socket.sent).toHaveLength(32);
  transport.dispose();
  expect((await outcomes).every((item) => item.status === "rejected")).toBe(true);
});
it("rejects oversized requests before emitting", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  await expect(
    transport({ ...command, params: { value: "x".repeat(524288) } }),
  ).rejects.toMatchObject({ code: "SOCKET_REQUEST_TOO_LARGE", outcomeUnknown: false });
  expect(socket.sent).toHaveLength(0);
  transport.dispose();
});

it("reserves control capacity while long reads wait", async () => {
  const socket = new SocketFixture();
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const read = {
    ...command,
    method: "agent.action.readIo",
    params: { execution_id: "e", after_sequence: 0, max_bytes: 65536, wait_ms: 20000 },
  };
  const reads = Array.from({ length: 16 }, (_, index) =>
    transport({ ...read, id: `read-${index}` }),
  );
  const outcomes = Promise.allSettled(reads);
  await expect(transport({ ...read, id: "extra-read" })).rejects.toMatchObject({
    code: "SOCKET_READER_CAPACITY",
  });
  const control = transport(command);
  const controlOutcome = Promise.allSettled([control]);
  expect(socket.sent).toHaveLength(17);
  expect(socket.sent.at(-1)?.event).toBe("agents:command");
  transport.dispose();
  await outcomes;
  await controlOutcome;
});

it("waits for writable transport and drops unsent work on disposal", async () => {
  vi.useFakeTimers();
  const socket = new SocketFixture();
  socket.io.engine.transport.writable = false;
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const request = transport(command);
  const rejected = expect(request).rejects.toMatchObject({
    code: "SOCKET_TRANSPORT_DISPOSED",
    outcomeUnknown: false,
  });
  await vi.advanceTimersByTimeAsync(10);
  expect(socket.sent).toHaveLength(0);
  transport.dispose();
  await rejected;
  socket.io.engine.transport.writable = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(socket.sent).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("charges writable wait to the request budget and emits only once", async () => {
  vi.useFakeTimers();
  const socket = new SocketFixture();
  socket.io.engine.transport.writable = false;
  const transport = createSocketActionIoTransport({ socket, agentId: "a" });
  const request = transport(command);
  const rejected = expect(request).rejects.toMatchObject({ code: "SOCKET_TRANSPORT_DISPOSED" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(socket.sent).toHaveLength(0);
  socket.io.engine.transport.writable = true;
  await vi.advanceTimersByTimeAsync(5);
  expect(socket.sent).toHaveLength(1);
  expect((socket.sent[0]!.payload as { timeoutMs: number }).timeoutMs).toBe(24995);
  await vi.advanceTimersByTimeAsync(100);
  expect(socket.sent).toHaveLength(1);
  transport.dispose();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
