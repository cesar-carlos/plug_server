import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";

import { agentRegistry } from "../../src/presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "../../src/presentation/socket/hub/registries/conversation_registry";
import { getActiveStreamRouteCount } from "../../src/presentation/socket/hub/registries/active_stream_registry";
import { getRelayRegisteredRouteCount } from "../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  registerSocketBridgeServer,
  registerConsumerBridgeServer,
  registerAgentBridgeSocket,
  registerConsumerBridgeSocket,
  dispatchRelayRpcToAgent,
  requestRelayStreamPull,
  handleAgentRpcResponse,
  handleAgentRpcChunk,
  handleAgentRpcComplete,
  resetSocketBridgeState,
  stopRelayMetricsLogger,
} from "../../src/presentation/socket/hub/relay/rpc_bridge";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord } from "../../src/shared/utils/rpc_types";
import { percentile } from "../../src/shared/utils/percentile";
import type { SocketBridgeBenchScenarioResult } from "./socket_bridge_bench_harness";

const decodedRecord = (raw: unknown): Record<string, unknown> => {
  const result = decodePayloadFrame(raw);
  if (!result.ok || !isRecord(result.value.data)) throw new Error("Invalid loopback frame");
  return result.value.data;
};

const connectSocket = async (url: string): Promise<Socket> => {
  const socket = connect(url, { transports: ["websocket"], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
};

/** Real Socket.IO relay transport; authentication and database persistence are outside this measurement. */
export const runLoopbackRelayBench = async (
  iterations: number,
  chunkCount: number,
  slowConsumer: boolean,
): Promise<SocketBridgeBenchScenarioResult> => {
  resetSocketBridgeState();
  const http = createServer();
  const hub = new Server(http, { transports: ["websocket"], perMessageDeflate: false });
  const agents = hub.of("/agents");
  const consumers = hub.of("/consumers");
  registerSocketBridgeServer(agents);
  registerConsumerBridgeServer(consumers);
  let failure: unknown;
  agents.on("connection", (socket) => {
    registerAgentBridgeSocket(agents, socket.id);
    agentRegistry.upsert({
      agentId: "bench-agent",
      socketId: socket.id,
      userId: null,
      capabilities: {},
    });
    agentRegistry.touchLiveness("bench-agent", { markProtocolReady: true, socketId: socket.id });
    socket.on(socketEvents.rpcResponse, (raw: unknown) => handleAgentRpcResponse(socket.id, raw));
    socket.on(socketEvents.rpcChunk, (raw: unknown) => handleAgentRpcChunk(socket.id, raw));
    socket.on(socketEvents.rpcComplete, (raw: unknown) => handleAgentRpcComplete(socket.id, raw));
  });
  consumers.on("connection", (socket) => {
    registerConsumerBridgeSocket(consumers, socket.id);
    socket.on(socketEvents.relayRpcRequest, (frame: unknown) => {
      void dispatchRelayRpcToAgent({
        conversationId: "bench-conversation",
        consumerSocketId: socket.id,
        rawFramePayload: frame,
      }).catch((error: unknown) => {
        failure = error;
      });
    });
    socket.on(socketEvents.relayRpcStreamPull, (frame: unknown) => {
      void requestRelayStreamPull({
        conversationId: "bench-conversation",
        consumerSocketId: socket.id,
        rawFramePayload: frame,
      }).catch((error: unknown) => {
        failure = error;
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const url = `http://127.0.0.1:${address.port}`;
  let agent: Socket | undefined;
  let consumer: Socket | undefined;
  let bytes = 0;
  let originalBytes = 0;
  let gzipFrames = 0;
  const send = (socket: Socket, event: string, body: unknown, requestId: string): void => {
    const frame = encodePayloadFrame(body, { requestId });
    bytes += frame.compressedSize;
    originalBytes += frame.originalSize;
    gzipFrames += frame.cmp === "gzip" ? 1 : 0;
    socket.emit(event, frame);
  };
  const samples: number[] = [];
  let duplicateChunks = 0;
  let chunksLost = 0;
  let orderOk = true;
  let peakHeap = process.memoryUsage().heapUsed;
  try {
    agent = await connectSocket(`${url}/agents`);
    consumer = await connectSocket(`${url}/consumers`);
    const agentSocketId = agent.id!;
    conversationRegistry.create({
      conversationId: "bench-conversation",
      consumerSocketId: consumer.id!,
      agentSocketId,
      agentId: "bench-agent",
    });
    const agentClient = agent;
    const nextChunkByRequest = new Map<string, number>();
    agent.on(socketEvents.rpcRequest, (raw: unknown) => {
      const request = decodedRecord(raw);
      const requestId = String(request.id);
      nextChunkByRequest.set(requestId, 0);
      send(
        agentClient,
        socketEvents.rpcResponse,
        { jsonrpc: "2.0", id: requestId, result: { stream_id: requestId } },
        requestId,
      );
    });
    agent.on(socketEvents.rpcStreamPull, (raw: unknown) => {
      const pull = decodedRecord(raw);
      const requestId = String(pull.request_id);
      const index = nextChunkByRequest.get(requestId) ?? 0;
      send(
        agentClient,
        socketEvents.rpcChunk,
        { request_id: requestId, stream_id: requestId, chunk_index: index, rows: [{ n: index }] },
        requestId,
      );
      nextChunkByRequest.set(requestId, index + 1);
      if (index + 1 === chunkCount) {
        send(
          agentClient,
          socketEvents.rpcComplete,
          { request_id: requestId, stream_id: requestId, total_rows: chunkCount },
          requestId,
        );
        nextChunkByRequest.delete(requestId);
      }
    });
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const seen = new Set<number>();
      const order: string[] = [];
      const client = consumer;
      let requestId = "";
      const pull = async (): Promise<void> => {
        if (slowConsumer) await delay(1);
        send(
          client,
          socketEvents.relayRpcStreamPull,
          { request_id: requestId, stream_id: requestId, window_size: 1 },
          requestId,
        );
      };
      const started = performance.now();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(failure ?? new Error("Loopback stream timed out")),
          5_000,
        );
        const response = (raw: unknown): void => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok) {
            reject(decoded.error);
            return;
          }
          requestId = String(decoded.value.frame.requestId);
          order.push("response");
          void pull().catch(reject);
        };
        const chunk = (raw: unknown): void => {
          const index = Number(decodedRecord(raw).chunk_index);
          if (seen.has(index)) duplicateChunks += 1;
          if (index !== seen.size) orderOk = false;
          seen.add(index);
          order.push("chunk");
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
          if (seen.size < chunkCount) void pull().catch(reject);
        };
        const complete = (): void => {
          clearTimeout(timer);
          client.off(socketEvents.relayRpcResponse, response);
          client.off(socketEvents.relayRpcChunk, chunk);
          client.off(socketEvents.relayRpcComplete, complete);
          order.push("complete");
          resolve();
        };
        client.on(socketEvents.relayRpcResponse, response);
        client.on(socketEvents.relayRpcChunk, chunk);
        client.on(socketEvents.relayRpcComplete, complete);
        send(
          client,
          socketEvents.relayRpcRequest,
          { jsonrpc: "2.0", id: `loop-${iteration}`, method: "agent.getHealth", params: {} },
          `loop-${iteration}`,
        );
      });
      samples.push(performance.now() - started);
      chunksLost += Math.max(0, chunkCount - seen.size);
      orderOk &&=
        order[0] === "response" && order.at(-1) === "complete" && order.length === chunkCount + 2;
    }
    if (failure) throw failure;
    if (getActiveStreamRouteCount() !== 0 || getRelayRegisteredRouteCount() !== 0)
      throw new Error("Loopback relay retained completed routes");
    const total = samples.reduce((sum, value) => sum + value, 0);
    return {
      name: slowConsumer ? "relay_loopback_slow_consumer" : "relay_loopback_stream",
      samples: samples.length,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      p99Ms: percentile(samples, 99),
      throughputPerSec: total > 0 ? (samples.length * 1000) / total : 0,
      bytes,
      originalBytes,
      gzipFrames,
      chunksLost,
      duplicateChunks,
      orderOk,
      heapUsedPeakBytes: peakHeap,
    };
  } finally {
    agent?.disconnect();
    consumer?.disconnect();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    stopRelayMetricsLogger();
    resetSocketBridgeState();
    agentRegistry.clear();
    conversationRegistry.clear();
  }
};
