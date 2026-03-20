import { randomBytes, randomUUID } from "node:crypto";

import type { Namespace } from "socket.io";

import { normalizeCommandForAgent } from "../../../application/agent_commands/command_transformers";
import { env } from "../../../shared/config/env";
import { badRequest, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import {
  bridgeCommandSchema,
  type PayloadFrameCompression,
} from "../../../shared/validators/agent_command";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  decodePayloadFrameAsync,
  encodePayloadFrameBridge,
  payloadFrameEncodeOptionsFromPreference,
} from "../../../shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteCount,
  removeActiveStreamRoute,
  upsertActiveStreamRoute,
} from "./active_stream_registry";
import {
  ensureAgentCircuitClosed,
  logRpcFrameDecodeFailure,
  registerAgentFailure,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import { conversationRegistry } from "./conversation_registry";
import { getOrCreateRelayIdempotencyMap } from "./relay_idempotency_store";
import { relayStreamFlowState } from "./relay_stream_flow_state";
import type { RelayRequestRoute } from "./relay_request_registry";
import {
  getRelayPendingRequestCountForConsumer,
  getRelayPendingRequestCountForConversation,
  getRelayRegisteredRouteCount,
  getRelayRequestRoute,
  registerRelayRequestRoute,
  removeRelayRequestRoute,
} from "./relay_request_registry";
import { resolveOutboundApiVersion } from "./rpc_bridge_command_helpers";
import {
  createRelayStreamHandlers,
  emitRelayTimeoutResponse,
  type EmitToConsumerFn,
} from "./rpc_bridge_relay_stream";
import type {
  RequestAgentStreamPullInput,
  RequestAgentStreamPullResult,
} from "./rpc_bridge_stream_pull";

const relayRequestTimeoutMs = env.socketRelayRequestTimeoutMs;
const relayMaxPendingRequests = env.socketRelayMaxPendingRequests;
const relayMaxPendingRequestsPerConversation = env.socketRelayMaxPendingRequestsPerConversation;
const relayMaxPendingRequestsPerConsumer = env.socketRelayMaxPendingRequestsPerConsumer;
const relayMaxActiveStreams = env.socketRelayMaxActiveStreams;
const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export interface DispatchRelayRpcInput {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly rawFramePayload: unknown;
  /** Hub → agent PayloadFrame gzip for re-encoded `rpc:request` (consumer frame is decoded first). */
  readonly payloadFrameCompression?: PayloadFrameCompression;
}

export interface DispatchRelayRpcResult {
  readonly requestId: string;
  readonly clientRequestId?: string;
  readonly deduplicated?: boolean;
  readonly replayed?: boolean;
}

export interface RequestRelayStreamPullInput {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly rawFramePayload: unknown;
}

export interface RpcBridgeRelayDispatchDeps {
  readonly getAgentsNamespace: () => Namespace | null;
  readonly emitToConsumer: EmitToConsumerFn;
  readonly requestAgentStreamPull: (input: RequestAgentStreamPullInput) => RequestAgentStreamPullResult;
}

export type RpcBridgeRelayDispatchHandlers = {
  readonly dispatchRelayRpcToAgent: (input: DispatchRelayRpcInput) => Promise<DispatchRelayRpcResult>;
  readonly requestRelayStreamPull: (
    input: RequestRelayStreamPullInput,
  ) => Promise<RequestAgentStreamPullResult>;
};

export const createRpcBridgeRelayDispatch = (
  deps: RpcBridgeRelayDispatchDeps,
): RpcBridgeRelayDispatchHandlers => {
  const { getAgentsNamespace, emitToConsumer, requestAgentStreamPull } = deps;

  const dispatchRelayRpcToAgent = async (
    input: DispatchRelayRpcInput,
  ): Promise<DispatchRelayRpcResult> => {
    const decoded = await decodePayloadFrameAsync(input.rawFramePayload);
    if (!decoded.ok) {
      logRpcFrameDecodeFailure({
        eventName: socketEvents.relayRpcRequest,
        socketId: input.consumerSocketId,
        reason: decoded.error.message,
      });
      throw badRequest(decoded.error.message);
    }

    const rawCommand = toRecord(decoded.value.data);
    if (!rawCommand) {
      throw badRequest("relay:rpc.request frame must contain a JSON object payload");
    }

    const parsed = bridgeCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue ? `${firstIssue.path.join(".") || "command"}: ${firstIssue.message}` : "Invalid RPC command";
      throw badRequest(message);
    }

    const command = parsed.data;
    if (Array.isArray(command)) {
      throw badRequest("relay:rpc.request does not support batch; send a single JSON-RPC request");
    }

    const normalizedCommand = normalizeCommandForAgent(command);

    const conversation = conversationRegistry.findByConversationId(input.conversationId);
    if (!conversation || conversation.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Conversation not found");
    }

    if (getRelayRegisteredRouteCount() >= relayMaxPendingRequests) {
      throw serviceUnavailable("Relay pending request capacity reached");
    }

    if (
      getRelayPendingRequestCountForConversation(conversation.conversationId) >=
      relayMaxPendingRequestsPerConversation
    ) {
      throw serviceUnavailable("Relay pending request capacity reached for conversation");
    }

    if (
      getRelayPendingRequestCountForConsumer(conversation.consumerSocketId) >=
      relayMaxPendingRequestsPerConsumer
    ) {
      throw serviceUnavailable("Relay pending request capacity reached for consumer");
    }

    ensureAgentCircuitClosed(conversation.agentId);

    const nsp = getAgentsNamespace();
    if (!nsp) {
      throw serviceUnavailable("Socket bridge is not initialized");
    }

    const agentSocket = nsp.sockets.get(conversation.agentSocketId);
    if (!agentSocket) {
      throw serviceUnavailable("Agent socket is unavailable");
    }

    const cmdRecord = normalizedCommand as Record<string, unknown>;
    const clientRequestId = toRequestId(cmdRecord.id);
    if (clientRequestId) {
      const idempotencyMap = getOrCreateRelayIdempotencyMap(conversation.conversationId);
      const existing = idempotencyMap.get(clientRequestId);
      if (existing && existing.expiresAtMs > Date.now()) {
        relayMetrics.requestsDeduplicated += 1;
        if (existing.responseFrame) {
          emitToConsumer(conversation.consumerSocketId, socketEvents.relayRpcResponse, existing.responseFrame);
          return {
            requestId: existing.requestId,
            clientRequestId,
            deduplicated: true,
            replayed: true,
          };
        }

        return {
          requestId: existing.requestId,
          clientRequestId,
          deduplicated: true,
        };
      }
    }

    if (getActiveStreamRouteCount() >= relayMaxActiveStreams) {
      throw serviceUnavailable("Relay active stream capacity reached");
    }

    const requestId = randomUUID();

    const traceId = toRequestId(decoded.value.frame.traceId) ?? randomBytes(16).toString("hex");
    const existingMeta = toRecord(cmdRecord.meta) ?? {};
    const commandPayload: Record<string, unknown> = {
      ...normalizedCommand,
      id: requestId,
      api_version: resolveOutboundApiVersion(cmdRecord),
      meta: {
        ...existingMeta,
        conversation_id: conversation.conversationId,
        request_id: requestId,
        ...(clientRequestId !== null ? { client_request_id: clientRequestId } : {}),
        agent_id: conversation.agentId,
        timestamp: new Date().toISOString(),
        trace_id: traceId,
      },
    };

    const timeoutHandle = setTimeout(() => {
      const route = getRelayRequestRoute(requestId);
      if (!route) {
        return;
      }

      route.timedOut = true;
      relayMetrics.requestTimeouts += 1;
      registerAgentFailure(route.agentId);
      emitRelayTimeoutResponse(route, emitToConsumer);
      removeRelayRequestRoute(requestId);
      const existingStream = getActiveStreamRouteByRequestId(requestId);
      if (existingStream) {
        removeActiveStreamRoute(existingStream);
      }
    }, relayRequestTimeoutMs);

    const relayRoute: RelayRequestRoute = {
      requestId,
      conversationId: conversation.conversationId,
      consumerSocketId: conversation.consumerSocketId,
      agentSocketId: conversation.agentSocketId,
      agentId: conversation.agentId,
      timeoutHandle,
      createdAtMs: Date.now(),
      ...(clientRequestId !== null ? { clientRequestId } : {}),
    };

    registerRelayRequestRoute(relayRoute);
    relayStreamFlowState.creditsByRequestId.set(requestId, 0);
    relayStreamFlowState.bufferedChunksByRequestId.set(requestId, []);
    upsertActiveStreamRoute({
      requestId,
      agentSocketId: conversation.agentSocketId,
      streamHandlers: createRelayStreamHandlers(relayRoute, emitToConsumer),
    });

    const relayPayloadFrameOpts = payloadFrameEncodeOptionsFromPreference(input.payloadFrameCompression);

    try {
      agentSocket.emit(
        socketEvents.rpcRequest,
        await encodePayloadFrameBridge(commandPayload, {
          requestId,
          omitTraceId: true,
          ...relayPayloadFrameOpts,
        }),
      );
    } catch (error: unknown) {
      removeRelayRequestRoute(requestId);
      const existingStream = getActiveStreamRouteByRequestId(requestId);
      if (existingStream && existingStream.agentSocketId === conversation.agentSocketId) {
        removeActiveStreamRoute(existingStream);
      }
      registerAgentFailure(conversation.agentId);
      throw error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request");
    }

    if (clientRequestId) {
      const idempotencyMap = getOrCreateRelayIdempotencyMap(conversation.conversationId);
      idempotencyMap.set(clientRequestId, {
        requestId,
        expiresAtMs: Date.now() + relayIdempotencyTtlMs,
      });
    }

    relayMetrics.requestsAccepted += 1;
    conversationRegistry.touch(conversation.conversationId);

    return {
      requestId,
      ...(clientRequestId !== null ? { clientRequestId } : {}),
    };
  };

  const requestRelayStreamPull = async (
    input: RequestRelayStreamPullInput,
  ): Promise<RequestAgentStreamPullResult> => {
    const decoded = await decodePayloadFrameAsync(input.rawFramePayload);
    if (!decoded.ok) {
      logRpcFrameDecodeFailure({
        eventName: socketEvents.relayRpcStreamPull,
        socketId: input.consumerSocketId,
        reason: decoded.error.message,
      });
      throw badRequest(decoded.error.message);
    }

    const payload = toRecord(decoded.value.data);
    if (!payload) {
      throw badRequest("relay:rpc.stream.pull frame must contain a JSON object payload");
    }

    const conversation = conversationRegistry.findByConversationId(input.conversationId);
    if (!conversation || conversation.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Conversation not found");
    }

    const requestId = toRequestId(payload.request_id);
    const streamId = toRequestId(payload.stream_id);
    if (
      payload.window_size !== undefined &&
      (typeof payload.window_size !== "number" ||
        !Number.isFinite(payload.window_size) ||
        payload.window_size <= 0)
    ) {
      throw badRequest("relay:rpc.stream.pull window_size must be a positive number");
    }

    const result = requestAgentStreamPull({
      consumerSocketId: input.consumerSocketId,
      conversationId: input.conversationId,
      ...(requestId ? { requestId } : {}),
      ...(streamId ? { streamId } : {}),
      ...(
        typeof payload.window_size === "number" && Number.isFinite(payload.window_size)
          ? { windowSize: payload.window_size }
          : {}
      ),
    });

    conversationRegistry.touch(conversation.conversationId);
    return result;
  };

  return {
    dispatchRelayRpcToAgent,
    requestRelayStreamPull,
  };
};
