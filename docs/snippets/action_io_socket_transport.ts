import { ActionIoClientError, type ActionIoTransport } from "./action_io_reference_client";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord } from "../../src/shared/utils/rpc_types";
import { actionIoErrorDetails } from "../../src/shared/utils/action_io_error_details";

export interface ActionIoSocket {
  readonly connected: boolean;
  readonly io: { readonly engine?: { readonly transport?: { readonly writable?: boolean } } };
  readonly volatile: { emit(event: string, payload: unknown): unknown };
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown): unknown;
}
export type ActionIoSocketTransport = ActionIoTransport & { dispose(): void };
interface Pending {
  waitingRead: boolean;
  send?: () => void;
  resolve(value: unknown): void;
  reject(error: ActionIoClientError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Uses an already authenticated socket/conversation; never connects or retries. */
export const createSocketActionIoTransport = (options: {
  readonly socket: ActionIoSocket;
  readonly agentId: string;
  readonly relayConversationId?: string;
}): ActionIoSocketTransport => {
  const pending = new Map<string, Pending>();
  const relay = options.relayConversationId !== undefined;
  const event = relay ? "relay:rpc.response" : "agents:command_response";
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Wait before the first emission only. Never re-emit a dispatched mutation.
  const flush = (): void => {
    flushTimer = undefined;
    if (disposed || !options.socket.connected) return;
    for (const item of pending.values()) {
      if (!item.send) continue;
      if (options.socket.io.engine?.transport?.writable !== true) {
        flushTimer = setTimeout(flush, 5);
        return;
      }
      const send = item.send;
      delete item.send;
      send();
    }
  };
  const failAll = (code: string): void => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new ActionIoClientError(code, item.send === undefined));
    }
    pending.clear();
  };
  const disconnected = (): void => failAll("SOCKET_DISCONNECTED");
  const relayAccepted = (body: unknown): void => {
    if (
      !isRecord(body) ||
      body.success !== false ||
      body.conversationId !== options.relayConversationId ||
      typeof body.clientRequestId !== "string" ||
      !isRecord(body.error) ||
      typeof body.error.code !== "string"
    )
      return;
    const item = pending.get(body.clientRequestId);
    if (!item || item.send) return;
    pending.delete(body.clientRequestId);
    clearTimeout(item.timer);
    const details = actionIoErrorDetails(body.error.details);
    item.reject(
      new ActionIoClientError(
        body.error.code,
        details.outcome_unknown === true || details.effects_possible !== false,
        { ...details, request_id: body.clientRequestId },
      ),
    );
  };
  const received = (wire: unknown): void => {
    if (pending.size === 0) return;
    try {
      if (
        !isRecord(wire) ||
        typeof wire.originalSize !== "number" ||
        typeof wire.compressedSize !== "number" ||
        wire.originalSize > 1024 * 1024 ||
        wire.compressedSize > 1024 * 1024
      ) {
        failAll("INVALID_SOCKET_FRAME");
        return;
      }
      const bytes = wire.payload;
      const wireSize =
        bytes instanceof Uint8Array
          ? bytes.byteLength
          : Array.isArray(bytes)
            ? bytes.length
            : typeof bytes === "string"
              ? bytes.length
              : Number.POSITIVE_INFINITY;
      const wireLimit = typeof bytes === "string" ? 4 * Math.ceil((1024 * 1024) / 3) : 1024 * 1024;
      if (wireSize > wireLimit) {
        failAll("INVALID_SOCKET_FRAME");
        return;
      }
      const decoded = decodePayloadFrame(wire);
      if (!decoded.ok || !isRecord(decoded.value.data)) {
        failAll("INVALID_SOCKET_FRAME");
        return;
      }
      const body = decoded.value.data;
      let response: Record<string, unknown>;
      if (relay) {
        response = body;
      } else {
        if (body.agentId !== undefined && body.agentId !== options.agentId) return;
        if (
          !isRecord(body.response) ||
          body.response.type !== "single" ||
          !isRecord(body.response.item)
        ) {
          const id = body.requestId;
          if (typeof id === "string") {
            const item = pending.get(id);
            if (item) {
              pending.delete(id);
              clearTimeout(item.timer);
              if (
                body.success === false &&
                isRecord(body.error) &&
                typeof body.error.code === "string"
              ) {
                const details = actionIoErrorDetails(body.error.details);
                item.reject(
                  new ActionIoClientError(body.error.code, details.effects_possible !== false, {
                    ...details,
                    request_id: id,
                  }),
                );
              } else {
                item.reject(new ActionIoClientError("INVALID_SOCKET_ENVELOPE", true));
              }
            }
          }
          return;
        }
        const item = body.response.item;
        response = {
          jsonrpc: "2.0",
          id: item.id,
          ...(Object.hasOwn(item, "meta") ? { meta: item.meta } : {}),
          ...(Object.hasOwn(item, "api_version") ? { api_version: item.api_version } : {}),
        };
        if (
          item.success === true &&
          Object.hasOwn(item, "result") &&
          !Object.hasOwn(item, "error")
        ) {
          response.result = item.result;
        } else if (
          item.success === false &&
          isRecord(item.error) &&
          !Object.hasOwn(item, "result")
        ) {
          response.error = item.error;
        }
      }
      if (typeof response.id !== "string") return;
      const item = pending.get(response.id);
      if (!item) return;
      pending.delete(response.id);
      clearTimeout(item.timer);
      item.resolve(response);
    } catch {
      failAll("INVALID_SOCKET_FRAME");
    }
  };
  options.socket.on(event, received);
  if (relay) options.socket.on("relay:rpc.accepted", relayAccepted);
  options.socket.on("disconnect", disconnected);
  const transport: ActionIoTransport = async (command) => {
    if (disposed || !options.socket.connected)
      throw new ActionIoClientError("SOCKET_NOT_CONNECTED", false);
    if (pending.size >= 32 || pending.has(command.id))
      throw new ActionIoClientError("SOCKET_CAPACITY", false);
    if (Buffer.byteLength(JSON.stringify(command), "utf8") > 512 * 1024)
      throw new ActionIoClientError("SOCKET_REQUEST_TOO_LARGE", false);
    const waitingRead =
      command.method === "agent.action.readIo" &&
      typeof command.params.wait_ms === "number" &&
      command.params.wait_ms > 0;
    if (waitingRead && [...pending.values()].filter((item) => item.waitingRead).length >= 16) {
      throw new ActionIoClientError("SOCKET_READER_CAPACITY", false);
    }
    // Frame before reserving a waiter; preparation failure cannot have effects.
    const payload = relay
      ? {
          conversationId: options.relayConversationId,
          timeoutMs: 30000,
          frame: encodePayloadFrame(command, { compressionThreshold: Number.POSITIVE_INFINITY }),
        }
      : { agentId: options.agentId, timeoutMs: 30000, command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const dispatched = pending.get(command.id)?.send === undefined;
        pending.delete(command.id);
        reject(new ActionIoClientError("SOCKET_TIMEOUT", dispatched));
      }, 30000);
      pending.set(command.id, { resolve, reject, timer, waitingRead });
      const item = pending.get(command.id)!;
      const deadline = Date.now() + 30000;
      item.send = () => {
        try {
          payload.timeoutMs = Math.max(1, deadline - Date.now());
          options.socket.volatile.emit(relay ? "relay:rpc.request" : "agents:command", payload);
        } catch {
          pending.delete(command.id);
          clearTimeout(timer);
          item.reject(new ActionIoClientError("SOCKET_SEND_UNKNOWN", true));
        }
      };
      if (flushTimer === undefined) flush();
    });
  };
  return Object.assign(transport, {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      options.socket.off(event, received);
      if (relay) options.socket.off("relay:rpc.accepted", relayAccepted);
      options.socket.off("disconnect", disconnected);
      failAll("SOCKET_TRANSPORT_DISPOSED");
    },
  });
};
