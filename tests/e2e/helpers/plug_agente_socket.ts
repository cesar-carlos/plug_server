/**
 * Simulates plug_agente Socket.IO client behaviour on namespace `/agents`:
 * JWT in handshake auth.token, PayloadFrame on application events.
 */

import { io as ioClient, type Socket as IoSocket } from "socket.io-client";

import { env } from "../../../src/shared/config/env";
import { encodePayloadFrame, decodePayloadFrame } from "../../../src/shared/utils/payload_frame";

export type AgentSocket = IoSocket;

/** Default capabilities aligned with plug_agente negotiation (binary PayloadFrame). */
export const defaultPlugAgenteCapabilities = {
  protocols: ["jsonrpc-v2"],
  encodings: ["json"],
  compressions: ["gzip", "none"],
  extensions: {
    binaryPayload: true,
    protocolReadyAck: true,
  },
} as const;

export const waitForSocketEvent = <T>(
  socket: IoSocket,
  eventName: string,
  timeoutMs = 15_000,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
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
};

export const connectPlugAgenteSocket = (baseUrl: string, agentAccessToken: string): Promise<AgentSocket> => {
  return new Promise<AgentSocket>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agents`, {
      auth: { token: agentAccessToken },
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
    socket.on("connect_error", (err) => {
      socket.disconnect();
      reject(err);
    });
  });
};

export const emitAgentReady = (socket: AgentSocket, agentId: string, protocol = "jsonrpc-v2"): void => {
  socket.emit(
    "agent:ready",
    encodePayloadFrame({
      agent_id: agentId,
      timestamp: new Date().toISOString(),
      protocol,
    }),
  );
};

/**
 * Emits `agent:register` as PayloadFrame and waits for `agent:capabilities` (plug_agente flow).
 */
export const registerAgentOnHub = async (
  socket: AgentSocket,
  agentId: string,
  capabilities: Record<string, unknown> = defaultPlugAgenteCapabilities as unknown as Record<string, unknown>,
  options?: { readonly autoReady?: boolean },
): Promise<void> => {
  const capabilitiesPromise = waitForSocketEvent<unknown>(socket, "agent:capabilities");
  socket.emit(
    "agent:register",
    encodePayloadFrame({
      agentId,
      timestamp: new Date().toISOString(),
      capabilities,
    }),
  );
  await capabilitiesPromise;
  const extensions =
    typeof capabilities.extensions === "object" && capabilities.extensions !== null
      ? (capabilities.extensions as Record<string, unknown>)
      : null;
  const protocolReadyAck = extensions?.protocolReadyAck === true;
  const autoReady = options?.autoReady ?? true;

  if (protocolReadyAck && autoReady) {
    emitAgentReady(socket, agentId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return;
  }

  if (!protocolReadyAck && env.socketAgentProtocolReadyGraceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.socketAgentProtocolReadyGraceMs));
  }
};

export const emitAgentHeartbeat = (socket: AgentSocket, agentId: string): void => {
  socket.emit(
    "agent:heartbeat",
    encodePayloadFrame({
      agent_id: agentId,
      timestamp: new Date().toISOString(),
    }),
  );
};

/**
 * Emits `rpc:response` and waits for the hub Socket.IO ack (same contract as plug_agente `emitWithAck`).
 */
export const emitAgentRpcResponseWithAck = (
  socket: AgentSocket,
  frame: unknown,
  timeoutMs = 10_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for hub ack on rpc:response"));
    }, timeoutMs);
    socket.emit("rpc:response", frame, () => {
      clearTimeout(timer);
      resolve();
    });
  });
