import {
  observeBridgeRpcMethod,
  type BridgeRpcMethodMetricOutcome,
} from "../../../../application/services/bridge_rpc_method_metrics.service";
import { env } from "../../../../shared/config/env";
import { isPayloadFrameEnvelope } from "../../../../shared/utils/payload_frame";
import { toRequestId } from "../../../../shared/utils/rpc_types";
import { getRelayRequestRoute, type RelayRequestRoute } from "../registries/relay_request_registry";
import {
  getOrCreateRelayIdempotencyMap,
  setRelayIdempotencyEntry,
} from "../registries/relay_idempotency_store";

const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

/** Wire-level `requestId` carried by a PayloadFrame envelope, or `null` when absent. */
export const extractFrameRequestId = (rawPayload: unknown): string | null => {
  if (!isPayloadFrameEnvelope(rawPayload)) {
    return null;
  }
  return toRequestId(rawPayload.requestId);
};

/**
 * Resolve the JSON-RPC `body.id` to use on outbound synthetic responses.
 *
 * When a `RelayRequestRoute` is available we echo back the consumer's
 * `client_request_id` (JSON-RPC 2.0 §5). When we only have the wire-level
 * `requestId` (e.g. REST pending requests with no relay route), we fall
 * back to the wire id so consumers can still correlate via the envelope.
 * The hub-internal `requestId` continues to be used for `correlation_id`
 * fields (ops-facing) so support keeps a stable identifier.
 */
export const resolveOutboundBodyId = (
  requestId: string,
  relayRoute: RelayRequestRoute | null,
): string => relayRoute?.clientRequestId ?? requestId;

/** Relay routes owned by `agentSocketId` for the given candidate request ids (de-duplicated). */
export const findRelayRequestRoutesForAgentSocket = (
  candidateIds: readonly string[],
  agentSocketId: string,
): RelayRequestRoute[] => {
  const routes: RelayRequestRoute[] = [];
  const seen = new Set<string>();
  for (const requestId of candidateIds) {
    if (seen.has(requestId)) {
      continue;
    }
    seen.add(requestId);
    const route = getRelayRequestRoute(requestId);
    if (route && route.agentSocketId === agentSocketId) {
      routes.push(route);
    }
  }
  return routes;
};

/**
 * Stores the outbound response frame in the conversation idempotency map so a
 * late duplicate consumer request replays it. Returns the consumer socket ids
 * that were waiting on a replay of this `clientRequestId`, if any.
 */
export const persistRelayIdempotentResponseFrame = (
  route: RelayRequestRoute,
  responseFrame: unknown,
): ReadonlySet<string> | undefined => {
  if (!route.clientRequestId) {
    return undefined;
  }

  const idempotencyMap = getOrCreateRelayIdempotencyMap(route.conversationId);
  const previousEntry = idempotencyMap.get(route.clientRequestId);
  setRelayIdempotencyEntry(route.conversationId, route.clientRequestId, {
    requestId: route.requestId,
    expiresAtMs: Date.now() + relayIdempotencyTtlMs,
    responseFrame,
  });
  return previousEntry?.pendingReplayConsumerSocketIds;
};

/** Records the per-method relay outcome metric (latency from route creation to now). */
export const observeRelayRouteOutcome = (
  route: RelayRequestRoute,
  outcome: BridgeRpcMethodMetricOutcome,
): void => {
  observeBridgeRpcMethod({
    channel: "relay",
    method: route.jsonRpcMethod ?? "unknown",
    outcome,
    elapsedMs: Date.now() - route.createdAtMs,
  });
};
