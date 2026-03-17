import { randomUUID } from "node:crypto";

import type { Server } from "socket.io";

import { badRequest, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { logger } from "../../../shared/utils/logger";
import { socketEvents } from "../../../shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../../shared/utils/payload_frame";
import { agentRegistry } from "./agent_registry";

interface PendingRequest {
  readonly socketId: string;
  readonly resolve: (payload: unknown) => void;
  readonly timeoutHandle: NodeJS.Timeout;
  acked: boolean;
}

interface DispatchRpcCommandInput {
  readonly agentId: string;
  readonly command: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface DispatchRpcCommandResult {
  readonly requestId: string;
  readonly response: unknown;
}

const defaultRequestTimeoutMs = 15_000;
let ioInstance: Server | null = null;
const pendingRequests = new Map<string, PendingRequest>();

const toRequestId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
};

const pickResponseId = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  return toRequestId(record.id);
};

export const registerSocketBridgeServer = (io: Server): void => {
  ioInstance = io;
};

export const handleAgentRpcResponse = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const responseId = pickResponseId(decoded.value.data);
  if (!responseId) {
    return;
  }

  const pendingRequest = pendingRequests.get(responseId);
  if (!pendingRequest || pendingRequest.socketId !== socketId) {
    return;
  }

  if (!pendingRequest.acked) {
    logger.info("rpc_response_received_without_ack", { requestId: responseId, socketId });
  }

  clearTimeout(pendingRequest.timeoutHandle);
  pendingRequests.delete(responseId);
  pendingRequest.resolve(decoded.value.data);
};

export const handleAgentRpcAck = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const requestId = toRequestId(data.request_id);
  if (!requestId) {
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (pending && pending.socketId === socketId) {
    pending.acked = true;
    logger.info("rpc_ack_received", { requestId, socketId });
  }
};

export const handleAgentBatchAck = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const requestIds = Array.isArray(data.request_ids)
    ? (data.request_ids as unknown[]).map((id) => toRequestId(id)).filter((id): id is string => id !== null)
    : [];

  let ackedCount = 0;
  for (const requestId of requestIds) {
    const pending = pendingRequests.get(requestId);
    if (pending && pending.socketId === socketId) {
      pending.acked = true;
      ackedCount++;
    }
  }
  if (ackedCount > 0) {
    logger.info("rpc_batch_ack_received", { requestIds: requestIds.slice(0, 5), ackedCount, socketId });
  }
};

export const dispatchRpcCommandToAgent = async (
  input: DispatchRpcCommandInput,
): Promise<DispatchRpcCommandResult> => {
  const io = ioInstance;
  if (!io) {
    throw serviceUnavailable("Socket bridge is not initialized");
  }

  const registeredAgent = agentRegistry.findByAgentId(input.agentId);
  if (!registeredAgent) {
    if (agentRegistry.hasKnownAgentId(input.agentId)) {
      throw serviceUnavailable(`Agent ${input.agentId} is disconnected`);
    }

    throw notFound(`Agent ${input.agentId}`);
  }

  const agentSocket = io.sockets.sockets.get(registeredAgent.socketId);
  if (!agentSocket) {
    throw serviceUnavailable("Agent socket is unavailable");
  }

  const command = toRecord(input.command);
  if (!command) {
    throw badRequest("Command must be a JSON object");
  }

  const explicitRequestId = toRequestId(command.id);
  const requestId = explicitRequestId ?? randomUUID();
  const traceId = randomUUID();
  const baseCommand = explicitRequestId ? command : { ...command, id: requestId };
  const existingMeta = toRecord(command.meta) ?? {};
  const commandPayload = {
    ...baseCommand,
    api_version: "2.4",
    meta: {
      ...existingMeta,
      request_id: requestId,
      agent_id: input.agentId,
      timestamp: new Date().toISOString(),
      trace_id: traceId,
    },
  };
  const timeoutMs = input.timeoutMs ?? defaultRequestTimeoutMs;
  if (pendingRequests.has(requestId)) {
    throw badRequest("A request with this JSON-RPC id is already pending");
  }

  const response = await new Promise<unknown>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const pending = pendingRequests.get(requestId);
      const hadAck = pending?.acked ?? false;
      pendingRequests.delete(requestId);
      if (!hadAck) {
        logger.info("rpc_timeout_without_ack", { requestId, socketId: registeredAgent.socketId });
      }
      reject(serviceUnavailable("Timed out waiting for agent response"));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      socketId: registeredAgent.socketId,
      resolve,
      timeoutHandle,
      acked: false,
    });

    try {
      agentSocket.emit(
        socketEvents.rpcRequest,
        encodePayloadFrame(commandPayload, {
          requestId,
          traceId,
        }),
      );
    } catch (error: unknown) {
      clearTimeout(timeoutHandle);
      pendingRequests.delete(requestId);
      reject(error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request"));
    }
  });

  return {
    requestId,
    response,
  };
};
