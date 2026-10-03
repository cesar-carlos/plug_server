import {
  appendSqlStreamChunkRows,
  countSqlExecuteResultRowsInEnvelope,
  countSqlStreamChunkRows,
  mergeSqlStreamRpcResponse,
  mergeSqlStreamRpcResponseWithAppendedRows,
} from "../../../../application/agent_commands/merge_sql_stream_rpc_response";
import { env } from "../../../../shared/config/env";
import { serviceUnavailable } from "../../../../shared/errors/http_errors";
import { agentRegistry } from "../registries/agent_registry";
import {
  countOpenStreamRoutesForAgent,
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
  settleRestMaterializeSuccess,
  upsertActiveStreamRoute,
  type ActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  observeAgentLatency,
  registerAgentFailure,
  registerAgentSuccess,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import {
  REST_STREAM_AGGREGATE_CONSUMER_ID,
  restSqlStreamMaterializeConsumeChunk,
  restSqlStreamMaterializeSeedCredits,
} from "./rest_sql_stream_materialize";
import {
  clearRestPendingRequest,
  type PendingRequest,
  type StreamEventHandlers,
} from "../registries/rest_pending_requests";
import {
  resolveStreamChunkOriginalSizeBytes,
  type StreamChunkMetadata,
} from "./stream_chunk_metadata";

export interface RestStreamMaterializeParams {
  readonly socketId: string;
  readonly pendingRequest: PendingRequest;
  readonly decoded: { readonly data: unknown; readonly frame: { readonly originalSize: number } };
  readonly streamId: string;
  readonly emitRpcStreamPullForRoute: (route: ActiveStreamRoute, windowSize: number) => void;
}

/**
 * Materializes a deferred REST SQL stream into a single aggregated response.
 *
 * Opens an active stream route whose chunk/complete handlers accumulate rows
 * server-side (enforcing the configured row/chunk/byte caps), then resolves the
 * original REST pending request with the merged envelope. Extracted verbatim
 * from `handleAgentRpcResponse` (which had grown past 500 lines) so this
 * self-contained sub-flow is isolated and independently reasoned about.
 */
export const startRestStreamMaterialization = (params: RestStreamMaterializeParams): void => {
  const { socketId, pendingRequest, decoded, streamId, emitRpcStreamPullForRoute } = params;
  const initialJson = decoded.data;
  const timeoutHandle = pendingRequest.timeoutHandle;
  const resolveOnce = pendingRequest.resolve;
  const rejectOnce = pendingRequest.reject;
  const primaryRequestId = pendingRequest.primaryRequestId;
  const streamedRows: unknown[] = [];
  const pullWindow = agentRegistry.resolveStreamPullWindow(
    pendingRequest.agentId,
    env.socketRestStreamPullWindowSize,
  );
  const materializeMaxRows = env.socketRestSqlStreamMaterializeMaxRows;
  const materializeMaxChunks = env.socketRestSqlStreamMaterializeMaxChunks;
  const materializeMaxBytes = env.socketRestSqlStreamMaterializeMaxBytes;
  const effectivePolicy = agentRegistry.resolveEffectiveDispatchPolicy(pendingRequest.agentId);
  if (countOpenStreamRoutesForAgent(socketId) >= effectivePolicy.maxConcurrentStreams) {
    relayMetrics.restMaterializeActiveStreamLimitExceeded += 1;
    registerAgentFailure(pendingRequest.agentId, "rest");
    clearTimeout(pendingRequest.timeoutHandle);
    clearRestPendingRequest(pendingRequest);
    pendingRequest.reject(
      serviceUnavailable(
        `Agent active stream capacity reached (${effectivePolicy.maxConcurrentStreams})`,
      ),
    );
    return;
  }
  let aggregatedRowCount = countSqlExecuteResultRowsInEnvelope(initialJson);
  let aggregatedByteCount = 0;
  let chunkFramesSeen = 0;
  if (materializeMaxBytes > 0) {
    aggregatedByteCount = decoded.frame.originalSize;
  }

  if (materializeMaxRows > 0 && aggregatedRowCount > materializeMaxRows) {
    relayMetrics.restMaterializeRowLimitExceeded += 1;
    registerAgentFailure(pendingRequest.agentId, "rest");
    clearTimeout(pendingRequest.timeoutHandle);
    clearRestPendingRequest(pendingRequest);
    pendingRequest.reject(
      serviceUnavailable(
        "REST SQL stream materialization would exceed configured row limit (use Socket bridge for large streams)",
      ),
    );
    return;
  }

  const restMaterializeState = {
    settled: false,
    timeoutHandle,
    reject: rejectOnce,
    agentId: pendingRequest.agentId,
  };

  const admitNormalizedChunk = (chunkRows: number, chunkBytes: number): boolean => {
    const limit =
      materializeMaxChunks > 0 && chunkFramesSeen + 1 > materializeMaxChunks
        ? "chunk"
        : materializeMaxRows > 0 && aggregatedRowCount + chunkRows > materializeMaxRows
          ? "row"
          : materializeMaxBytes > 0 && aggregatedByteCount + chunkBytes > materializeMaxBytes
            ? "byte"
            : null;
    if (limit === null) return true;
    const counters = {
      chunk: "restMaterializeChunkLimitExceeded",
      row: "restMaterializeRowLimitExceeded",
      byte: "restMaterializeByteLimitExceeded",
    } as const;
    relayMetrics[counters[limit]] += 1;
    registerAgentFailure(pendingRequest.agentId, "rest");
    const route = getActiveStreamRouteByRequestId(primaryRequestId);
    if (route) removeActiveStreamRoute(route, { restMaterialize: "detach" });
    rejectOnce(
      serviceUnavailable(
        `REST SQL stream materialization exceeded configured ${limit} limit (use Socket bridge for large streams)`,
      ),
    );
    return false;
  };

  const streamHandlers: StreamEventHandlers = {
    consumerSocketId: REST_STREAM_AGGREGATE_CONSUMER_ID,
    mode: "legacy",
    admitNormalizedChunk,
    onChunk: (payload, metadata?: StreamChunkMetadata) => {
      const chunkRows = countSqlStreamChunkRows(payload);
      const chunkBytes =
        materializeMaxBytes > 0 ? resolveStreamChunkOriginalSizeBytes(payload, metadata, 0) : 0;
      if (!admitNormalizedChunk(chunkRows, chunkBytes)) return;
      chunkFramesSeen += 1;
      if (materializeMaxBytes > 0) aggregatedByteCount += chunkBytes;

      aggregatedRowCount += chunkRows;
      appendSqlStreamChunkRows(streamedRows, payload);
      restSqlStreamMaterializeConsumeChunk(primaryRequestId, pullWindow, () => {
        const route = getActiveStreamRouteByRequestId(primaryRequestId);
        if (route) {
          emitRpcStreamPullForRoute(route, pullWindow);
        }
      });
    },
    onComplete: (payload) => {
      const active = getActiveStreamRouteByRequestId(primaryRequestId);
      if (active) {
        settleRestMaterializeSuccess(active);
      } else {
        restMaterializeState.settled = true;
        clearTimeout(timeoutHandle);
      }
      try {
        const merged =
          streamedRows.length > 0
            ? mergeSqlStreamRpcResponseWithAppendedRows(initialJson, streamedRows, payload)
            : mergeSqlStreamRpcResponse(initialJson, [], payload);
        relayMetrics.restSqlStreamMaterializeCompleted += 1;
        relayMetrics.restSqlStreamMaterializeRowsMerged +=
          countSqlExecuteResultRowsInEnvelope(merged);
        pendingRequest.latencyTrace?.recordPendingResolveEnd();
        resolveOnce(merged);
      } catch (err) {
        const mergeError = err instanceof Error ? err : new Error("Failed to merge SQL stream");
        if (mergeError.message.startsWith("Agent SQL stream ended with terminal_status=")) {
          rejectOnce(serviceUnavailable(mergeError.message));
          return;
        }
        rejectOnce(mergeError);
      }
    },
  };

  upsertActiveStreamRoute({
    requestId: primaryRequestId,
    agentSocketId: socketId,
    agentId: pendingRequest.agentId,
    streamHandlers,
    streamId,
    restMaterializeState,
  });
  registerAgentSuccess(pendingRequest.agentId, "rest");
  observeAgentLatency(pendingRequest.agentId, Date.now() - pendingRequest.createdAtMs);
  clearRestPendingRequest(pendingRequest);
  pendingRequest.onStreamMaterializeStarted?.();

  const route = getActiveStreamRouteByRequestId(primaryRequestId);
  if (route) {
    emitRpcStreamPullForRoute(route, pullWindow);
    restSqlStreamMaterializeSeedCredits(primaryRequestId, pullWindow);
  }
};
