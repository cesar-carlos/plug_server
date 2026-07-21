type ConsumerAuthRejectReason =
  | "missing_token"
  | "invalid_token"
  | "role_denied"
  | "blocked_account";

const activeConnections = {
  user: 0,
  client: 0,
  unknown: 0,
};

const authRejects: Record<ConsumerAuthRejectReason, number> = {
  missing_token: 0,
  invalid_token: 0,
  role_denied: 0,
  blocked_account: 0,
};

const guardDb = {
  count: 0,
  sumMs: 0,
  maxMs: 0,
};

const commandAbort = {
  abortedCommandsTotal: 0,
};

const retryAfter = {
  socketErrorRetryAfterMsTotal: 0,
  agentsCommandRetryAfterSecondsTotal: 0,
};

/**
 * Adoption / efficacy counters for the relay opt-ins shipped in the
 * "Socket performance v2" workstream. See:
 *
 * - `docs/socket_relay_protocol.md` ("Relay unary fast-path")
 * - `docs/socket_relay_protocol.md` ("Server-side phase diagnostics")
 * - `docs/api_rest_bridge.md` ("Server-side phase diagnostics")
 *
 * Counters are cumulative per process. Use `rate()` in Prometheus to derive
 * the in-window adoption percentage:
 *
 *   rate(plug_socket_relay_fast_path_total{outcome="honored"}[5m])
 *     / sum without (outcome) (rate(plug_socket_relay_fast_path_total[5m]))
 */
const relayOptInsCounters = {
  /** Counter: incremented when the consumer set `fastPath: true` on `relay:rpc.request`. */
  fastPathRequestedTotal: 0,
  /** Counter: incremented when the hub honored fast-path (no `relay:rpc.accepted` emitted). */
  fastPathHonoredTotal: 0,
  /** Counter: incremented when fast-path fell back to emit `relay:rpc.accepted` due to dedup. */
  fastPathFallbackDedupTotal: 0,
  /** Counter: incremented when fast-path emitted `relay:rpc.accepted` because dispatch errored. */
  fastPathFallbackErrorTotal: 0,
  /**
   * Counter: incremented when the hub forwarded a streaming `relay:rpc.response`
   * (`stream_id` present) for a route that had `fastPath: true`. Useful to spot
   * misuse (consumer set fast-path on a streaming-capable method).
   */
  fastPathStreamInadvertentTotal: 0,
  /**
   * Counter: incremented when a consumer requested `fastPath: true` but the
   * deployment had `SOCKET_RELAY_FAST_PATH_FORBIDDEN=true` and the hub forced
   * the legacy 3-event flow. Should be `0` unless an operator explicitly set
   * the env knob — non-zero values during normal operations indicate a
   * misconfigured deployment.
   */
  fastPathForbiddenTotal: 0,
  /**
   * Counter: `relay:conversation.start` rejected because presence shows the agent
   * on another hub (sticky affinity required; not the same as agent offline).
   */
  conversationStartRemoteHubTotal: 0,
  /**
   * Counter: incremented when the hub rewrote the JSON-RPC `body.id` of a
   * relay response from the hub-internal `requestId` back to the consumer's
   * `client_request_id` before forwarding `relay:rpc.response`. Tracks the
   * adoption of the JSON-RPC 2.0 §5 fix that unblocked relay `fastPath: true`.
   * Should track ~1:1 with relay unary responses on Opcao B (legacy agents);
   * drops to ~0 when `clientRequestIdEcho: "v1"` is negotiated (Opcao A,
   * ADR 0009, shipped 2026-06-24).
   */
  bodyIdEchoTotal: 0,
  /**
   * Sum of milliseconds spent in the body.id rewrite path (parse JSON →
   * mutate id → re-encode). Pairs with `bodyIdEchoTotal` to derive
   * `avg_ms = sum / total`. Synthetic error builders (timeout, decode
   * failure, etc.) skip this measurement because they do not pay the
   * parse-mutate cost — they build a fresh object end-to-end.
   */
  bodyIdEchoOverheadSumMs: 0,
  /** Max single-shot overhead (ms) — useful to detect tail regressions. */
  bodyIdEchoOverheadMaxMs: 0,
  /** Counter: incremented when the consumer set `requestServerTimings: true` on `relay:rpc.request`. */
  serverTimingsRelayOptInTotal: 0,
  /** Counter: incremented when the consumer set `requestServerTimings: true` on `agents:command` (Socket). */
  serverTimingsAgentsCommandOptInTotal: 0,
  /** Counter: incremented when the consumer set `requestServerTimings: true` on `POST /api/v1/agents/commands` (REST). */
  serverTimingsRestOptInTotal: 0,
  /**
   * Counter: agent `rpc:response` arrived after the hub already timed out the
   * relay route — response is dropped (consumer already received timeout).
   */
  lateResponseAfterTimeoutTotal: 0,
  /** Counter: relay stream chunks dropped after `rpc:complete` was already received. */
  chunkAfterCompleteDroppedTotal: 0,
  /**
   * Counter: relay outbound job failed but a synthetic `relay:rpc.response`
   * error frame was emitted to the consumer (best-effort).
   */
  relayOutboundJobFailureNotifiedTotal: 0,
  /** Counter: any `relay:rpc.request.batch` envelope received (after socket-level Zod). */
  batchEnvelopesReceivedTotal: 0,
  /** Counter: batch envelopes that fully passed validation + acquired inflight slots + got dispatched. */
  batchEnvelopesAcceptedTotal: 0,
  /** Histogram-ish: cumulative sum of items across all accepted batches (rate = avg batch size when divided by accepted). */
  batchItemsAcceptedTotal: 0,
  /** Counter: items in accepted batches that resolved as deduplicated against an inflight or cached request. */
  batchItemsDedupedTotal: 0,
  /** Counter: items in accepted batches that failed dispatch with an error. */
  batchItemsErrorTotal: 0,
  /** Counter: envelopes rejected, labelled by reason. */
  batchEnvelopesRejectedTotal: {
    disabled: 0,
    not_found: 0,
    frame_decode_failed: 0,
    not_array: 0,
    validation_failed: 0,
    rate_limited: 0,
    inflight_gate: 0,
    envelope_error: 0,
  } as Record<RelayBatchRejectReason, number>,
  batchEnvelopeDecode: {
    count: 0,
    sumMs: 0,
    maxMs: 0,
  },
  batchItemsPerEnvelope: {
    count: 0,
    sum: 0,
    max: 0,
  },
};

export type RelayBatchRejectReason =
  | "disabled"
  | "not_found"
  | "frame_decode_failed"
  | "not_array"
  | "validation_failed"
  | "rate_limited"
  | "inflight_gate"
  | "envelope_error";

const profilePush = {
  batchesTotal: 0,
  coalescedTotal: 0,
  fanoutTotal: 0,
  fanoutMax: 0,
};

const customEvents = {
  subscriptionsActive: 0,
  subscribedTotal: 0,
  unsubscribedTotal: 0,
  subscriptionRejectedTotal: 0,
  subscriptionForbiddenTotal: 0,
  publishAcceptedTotal: 0,
  publishRejectedTotal: 0,
  publishIdempotentReplayTotal: 0,
  publishRecipientsTotal: 0,
  publishAttachmentBytesTotal: 0,
  publishViaSocketTotal: 0,
  publishIdempotencySerializationCapRejectedTotal: 0,
  publishDistributedRecipientCountFailedTotal: 0,
  publishDistributedRecipientCountSkippedTotal: 0,
  publishDistributedRecipientCountCircuitOpenedTotal: 0,
  publishDistributedRecipientCountCircuitRejectedTotal: 0,
  publishDistributedRecipientCountCircuitOpen: 0,
  publishRecipientCountBestEffortTotal: 0,
  publishRecipientCapUnverifiedTotal: 0,
  /**
   * Number of `client:custom.*` publishes that reused the cluster-wide
   * `fetchSockets()` result from the recipient-count step instead of
   * issuing a second RPC for principal-id resolution. Sustained growth
   * confirms the dedupe path is hot; a flat zero indicates the publish
   * is not exercising both paths simultaneously.
   */
  publishFetchSocketsDedupesTotal: 0,
};

/** Live `grantClientAccess` on this process only (multi-replica: see docs). */
const consumerClientAgentRoomGrant = {
  attemptsTotal: 0,
  socketsJoinedTotal: 0,
  joinFailuresTotal: 0,
  fetchFailuresTotal: 0,
};

const consumerClientAgentRoomReconcile = {
  runsTotal: 0,
  clientsEvaluatedTotal: 0,
  clientsDeferredTotal: 0,
  socketsEvaluatedTotal: 0,
  roomsJoinedTotal: 0,
  roomsLeftTotal: 0,
  failuresTotal: 0,
  ticksSkippedTotal: 0,
  inFlight: 0,
};

const consumerClientAgentRoomBootstrap = {
  startedTotal: 0,
  completedTotal: 0,
  failedTotal: 0,
  pending: 0,
  durationSumMs: 0,
  durationMaxMs: 0,
  fetchReusedTotal: 0,
};

const profilePushRecipientFetch = {
  reusedInFlightTotal: 0,
};

const roomDisconnect = {
  agentTriggeredTotal: 0,
  consumerTriggeredTotal: 0,
};

let consumerIdleTimeoutDisconnectTotal = 0;

/** Upper bounds for Prometheus-style cumulative histogram of publish recipient fan-out. */
const PUBLISH_RECIPIENT_HIST_UPPER_BOUNDS = [
  0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536, 131_072,
  262_144, 524_288, 1_048_576,
] as const;

let publishRecipientsHistSum = 0;
let publishRecipientsHistCount = 0;
const publishRecipientsHistBuckets = new Map<number, number>();
let publishRecipientsHistInf = 0;

const observePublishRecipientsHistogram = (recipients: number): void => {
  const v = Math.max(0, recipients);
  publishRecipientsHistSum += v;
  publishRecipientsHistCount += 1;
  for (const b of PUBLISH_RECIPIENT_HIST_UPPER_BOUNDS) {
    if (v <= b) {
      publishRecipientsHistBuckets.set(b, (publishRecipientsHistBuckets.get(b) ?? 0) + 1);
    }
  }
  publishRecipientsHistInf += 1;
};

export const noteConsumerSocketConnected = (
  principalType: "user" | "client" | null | undefined,
): void => {
  if (principalType === "client") {
    activeConnections.client += 1;
    return;
  }
  if (principalType === "user") {
    activeConnections.user += 1;
    return;
  }
  activeConnections.unknown += 1;
};

export const noteConsumerSocketDisconnected = (
  principalType: "user" | "client" | null | undefined,
): void => {
  if (principalType === "client") {
    activeConnections.client = Math.max(0, activeConnections.client - 1);
    return;
  }
  if (principalType === "user") {
    activeConnections.user = Math.max(0, activeConnections.user - 1);
    return;
  }
  activeConnections.unknown = Math.max(0, activeConnections.unknown - 1);
};

export const noteConsumerSocketAuthRejected = (reason: ConsumerAuthRejectReason): void => {
  authRejects[reason] += 1;
};

/** DB round-trip latency for JWT account snapshot validation (handshake + per-event guards). */
export const observeSocketAuthAccountDbValidation = (elapsedMs: number): void => {
  const safeElapsedMs = Math.max(0, elapsedMs);
  guardDb.count += 1;
  guardDb.sumMs += safeElapsedMs;
  guardDb.maxMs = Math.max(guardDb.maxMs, safeElapsedMs);
};

/** @deprecated Use {@link observeSocketAuthAccountDbValidation}. */
export const observeConsumerGuardDbValidation = observeSocketAuthAccountDbValidation;

export const noteConsumerPendingCommandsAborted = (count: number): void => {
  commandAbort.abortedCommandsTotal += Math.max(0, count);
};

export const noteConsumerProfilePushBatch = (fanout: number): void => {
  const safeFanout = Math.max(0, fanout);
  profilePush.batchesTotal += 1;
  profilePush.fanoutTotal += safeFanout;
  profilePush.fanoutMax = Math.max(profilePush.fanoutMax, safeFanout);
};

export const noteConsumerProfilePushCoalesced = (): void => {
  profilePush.coalescedTotal += 1;
};

export const noteSocketErrorRetryAfterMsPropagated = (): void => {
  retryAfter.socketErrorRetryAfterMsTotal += 1;
};

export const noteRelayFastPathRequested = (): void => {
  relayOptInsCounters.fastPathRequestedTotal += 1;
};

export const noteRelayFastPathHonored = (): void => {
  relayOptInsCounters.fastPathHonoredTotal += 1;
};

export const noteRelayFastPathFallbackDedup = (): void => {
  relayOptInsCounters.fastPathFallbackDedupTotal += 1;
};

export const noteRelayFastPathFallbackError = (): void => {
  relayOptInsCounters.fastPathFallbackErrorTotal += 1;
};

export const noteRelayFastPathStreamInadvertent = (): void => {
  relayOptInsCounters.fastPathStreamInadvertentTotal += 1;
};

export const noteRelayFastPathForbidden = (): void => {
  relayOptInsCounters.fastPathForbiddenTotal += 1;
};

export const noteRelayConversationStartRemoteHub = (): void => {
  relayOptInsCounters.conversationStartRemoteHubTotal += 1;
};

export const noteRelayLateResponseAfterTimeout = (): void => {
  relayOptInsCounters.lateResponseAfterTimeoutTotal += 1;
};

export const noteRelayChunkAfterCompleteDropped = (): void => {
  relayOptInsCounters.chunkAfterCompleteDroppedTotal += 1;
};

export const noteRelayOutboundJobFailureNotified = (): void => {
  relayOptInsCounters.relayOutboundJobFailureNotifiedTotal += 1;
};

export const noteRelayBodyIdEcho = (): void => {
  relayOptInsCounters.bodyIdEchoTotal += 1;
};

/**
 * Like {@link noteRelayBodyIdEcho} but also records the wall-clock cost of
 * the rewrite path. Use only on the **re-encode** call site
 * (`rpc_bridge_agent_inbound.ts` forwarder). Synthetic error builders that
 * already construct a fresh JSON object do not measure the overhead — for
 * those callers, prefer {@link noteRelayBodyIdEcho}.
 */
export const observeRelayBodyIdEchoOverhead = (elapsedMs: number): void => {
  relayOptInsCounters.bodyIdEchoTotal += 1;
  const safe = Math.max(0, elapsedMs);
  relayOptInsCounters.bodyIdEchoOverheadSumMs += safe;
  if (safe > relayOptInsCounters.bodyIdEchoOverheadMaxMs) {
    relayOptInsCounters.bodyIdEchoOverheadMaxMs = safe;
  }
};

export const noteRelayBatchEnvelopeReceived = (): void => {
  relayOptInsCounters.batchEnvelopesReceivedTotal += 1;
};

export const noteRelayBatchAccepted = (input: {
  readonly itemCount: number;
  readonly dedupedCount: number;
  readonly errorCount: number;
}): void => {
  relayOptInsCounters.batchEnvelopesAcceptedTotal += 1;
  relayOptInsCounters.batchItemsAcceptedTotal += input.itemCount;
  relayOptInsCounters.batchItemsDedupedTotal += input.dedupedCount;
  relayOptInsCounters.batchItemsErrorTotal += input.errorCount;
};

export const noteRelayBatchRejected = (reason: RelayBatchRejectReason): void => {
  relayOptInsCounters.batchEnvelopesRejectedTotal[reason] += 1;
};

export const observeRelayBatchEnvelopeDecodeMs = (elapsedMs: number): void => {
  const safe = Math.max(0, elapsedMs);
  relayOptInsCounters.batchEnvelopeDecode.count += 1;
  relayOptInsCounters.batchEnvelopeDecode.sumMs += safe;
  if (safe > relayOptInsCounters.batchEnvelopeDecode.maxMs) {
    relayOptInsCounters.batchEnvelopeDecode.maxMs = safe;
  }
};

export const observeRelayBatchItemsPerEnvelope = (itemCount: number): void => {
  const safe = Math.max(0, itemCount);
  relayOptInsCounters.batchItemsPerEnvelope.count += 1;
  relayOptInsCounters.batchItemsPerEnvelope.sum += safe;
  if (safe > relayOptInsCounters.batchItemsPerEnvelope.max) {
    relayOptInsCounters.batchItemsPerEnvelope.max = safe;
  }
};

export const noteServerTimingsOptIn = (channel: "relay" | "agents_command" | "rest"): void => {
  switch (channel) {
    case "relay":
      relayOptInsCounters.serverTimingsRelayOptInTotal += 1;
      return;
    case "agents_command":
      relayOptInsCounters.serverTimingsAgentsCommandOptInTotal += 1;
      return;
    case "rest":
      relayOptInsCounters.serverTimingsRestOptInTotal += 1;
      return;
  }
};

export const noteAgentsCommandRetryAfterSecondsPropagated = (): void => {
  retryAfter.agentsCommandRetryAfterSecondsTotal += 1;
};

export const noteCustomSocketEventSubscribed = (): void => {
  customEvents.subscriptionsActive += 1;
  customEvents.subscribedTotal += 1;
};

export const noteCustomSocketEventUnsubscribed = (): void => {
  customEvents.subscriptionsActive = Math.max(0, customEvents.subscriptionsActive - 1);
  customEvents.unsubscribedTotal += 1;
};

export const noteCustomSocketEventSubscriptionsRemoved = (count: number): void => {
  customEvents.subscriptionsActive = Math.max(0, customEvents.subscriptionsActive - count);
  customEvents.unsubscribedTotal += Math.max(0, count);
};

export const noteCustomSocketEventSubscriptionRejected = (): void => {
  customEvents.subscriptionRejectedTotal += 1;
};

export const noteCustomSocketEventSubscriptionForbidden = (): void => {
  customEvents.subscriptionForbiddenTotal += 1;
};

export const noteCustomSocketEventPublishAccepted = (input: {
  readonly recipients: number;
  readonly attachmentBytes: number;
}): void => {
  customEvents.publishAcceptedTotal += 1;
  customEvents.publishRecipientsTotal += Math.max(0, input.recipients);
  customEvents.publishAttachmentBytesTotal += Math.max(0, input.attachmentBytes);
  observePublishRecipientsHistogram(input.recipients);
};

export const noteCustomSocketEventPublishRejected = (): void => {
  customEvents.publishRejectedTotal += 1;
};

export const noteCustomSocketEventPublishIdempotentReplay = (): void => {
  customEvents.publishIdempotentReplayTotal += 1;
};

export const noteCustomSocketEventPublishViaSocket = (): void => {
  customEvents.publishViaSocketTotal += 1;
};

export const noteClientSocketEventPublishIdempotencySerializationCapRejected = (): void => {
  customEvents.publishIdempotencySerializationCapRejectedTotal += 1;
};

export const noteCustomSocketEventPublishDistributedRecipientCountFailed = (): void => {
  customEvents.publishDistributedRecipientCountFailedTotal += 1;
};

export const noteCustomSocketEventPublishDistributedRecipientCountSkipped = (): void => {
  customEvents.publishDistributedRecipientCountSkippedTotal += 1;
};

export const noteCustomSocketEventPublishDistributedRecipientCountCircuitOpened = (): void => {
  customEvents.publishDistributedRecipientCountCircuitOpenedTotal += 1;
  customEvents.publishDistributedRecipientCountCircuitOpen = 1;
};

export const noteCustomSocketEventPublishDistributedRecipientCountCircuitClosed = (): void => {
  customEvents.publishDistributedRecipientCountCircuitOpen = 0;
};

export const noteCustomSocketEventPublishDistributedRecipientCountCircuitRejected = (): void => {
  customEvents.publishDistributedRecipientCountCircuitRejectedTotal += 1;
};

export const noteCustomSocketEventPublishRecipientCountBestEffort = (): void => {
  customEvents.publishRecipientCountBestEffortTotal += 1;
};

export const noteCustomSocketEventPublishRecipientCapUnverified = (): void => {
  customEvents.publishRecipientCapUnverifiedTotal += 1;
};

export const noteCustomSocketEventPublishFetchSocketsDedupe = (): void => {
  customEvents.publishFetchSocketsDedupesTotal += 1;
};

export const noteConsumerClientAgentRoomGrantAttempt = (): void => {
  consumerClientAgentRoomGrant.attemptsTotal += 1;
};

export const noteConsumerClientAgentRoomGrantSocketsJoined = (count: number): void => {
  consumerClientAgentRoomGrant.socketsJoinedTotal += Math.max(0, count);
};

export const noteConsumerClientAgentRoomGrantJoinFailed = (): void => {
  consumerClientAgentRoomGrant.joinFailuresTotal += 1;
};

export const noteConsumerClientAgentRoomGrantFetchFailed = (): void => {
  consumerClientAgentRoomGrant.fetchFailuresTotal += 1;
};

export const noteConsumerClientAgentRoomReconcileStarted = (
  clientCount: number,
  socketCount: number,
): void => {
  consumerClientAgentRoomReconcile.runsTotal += 1;
  consumerClientAgentRoomReconcile.clientsEvaluatedTotal += Math.max(0, clientCount);
  consumerClientAgentRoomReconcile.socketsEvaluatedTotal += Math.max(0, socketCount);
  consumerClientAgentRoomReconcile.inFlight = 1;
};

export const noteConsumerClientAgentRoomReconcileDeferred = (count: number): void => {
  consumerClientAgentRoomReconcile.clientsDeferredTotal += Math.max(0, count);
};

export const noteConsumerClientAgentRoomReconcileFinished = (): void => {
  consumerClientAgentRoomReconcile.inFlight = 0;
};

export const noteConsumerClientAgentRoomReconcileRoomsJoined = (count: number): void => {
  consumerClientAgentRoomReconcile.roomsJoinedTotal += Math.max(0, count);
};

export const noteConsumerClientAgentRoomReconcileRoomsLeft = (count: number): void => {
  consumerClientAgentRoomReconcile.roomsLeftTotal += Math.max(0, count);
};

export const noteConsumerClientAgentRoomReconcileFailed = (): void => {
  consumerClientAgentRoomReconcile.failuresTotal += 1;
};

export const noteConsumerClientAgentRoomReconcileTickSkipped = (): void => {
  consumerClientAgentRoomReconcile.ticksSkippedTotal += 1;
};

export const noteConsumerClientAgentRoomBootstrapStarted = (): number => {
  consumerClientAgentRoomBootstrap.startedTotal += 1;
  consumerClientAgentRoomBootstrap.pending += 1;
  return performance.now();
};

export const noteConsumerClientAgentRoomBootstrapCompleted = (startedAt: number): void => {
  consumerClientAgentRoomBootstrap.completedTotal += 1;
  consumerClientAgentRoomBootstrap.pending = Math.max(
    0,
    consumerClientAgentRoomBootstrap.pending - 1,
  );
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  consumerClientAgentRoomBootstrap.durationSumMs += elapsedMs;
  consumerClientAgentRoomBootstrap.durationMaxMs = Math.max(
    consumerClientAgentRoomBootstrap.durationMaxMs,
    elapsedMs,
  );
};

export const noteConsumerClientAgentRoomBootstrapFailed = (): void => {
  consumerClientAgentRoomBootstrap.failedTotal += 1;
  consumerClientAgentRoomBootstrap.pending = Math.max(
    0,
    consumerClientAgentRoomBootstrap.pending - 1,
  );
};

export const noteConsumerClientAgentRoomBootstrapFetchReused = (): void => {
  consumerClientAgentRoomBootstrap.fetchReusedTotal += 1;
};

export const noteConsumerProfilePushRecipientFetchReused = (): void => {
  profilePushRecipientFetch.reusedInFlightTotal += 1;
};

export const noteAgentRoomDisconnectTriggered = (): void => {
  roomDisconnect.agentTriggeredTotal += 1;
};

export const noteConsumerRoomDisconnectTriggered = (): void => {
  roomDisconnect.consumerTriggeredTotal += 1;
};

export const noteConsumerIdleTimeoutDisconnect = (count = 1): void => {
  if (count > 0) {
    consumerIdleTimeoutDisconnectTotal += count;
  }
};

export const getSocketConsumerMetricsSnapshot = (): {
  readonly activeConnections: typeof activeConnections;
  readonly authRejects: typeof authRejects;
  readonly guardDb: {
    readonly count: number;
    readonly sumMs: number;
    readonly avgMs: number;
    readonly maxMs: number;
  };
  readonly commandAbort: typeof commandAbort;
  readonly retryAfter: typeof retryAfter;
  readonly relayOptIns: typeof relayOptInsCounters;
  readonly customEvents: typeof customEvents;
  readonly consumerClientAgentRoomGrant: typeof consumerClientAgentRoomGrant;
  readonly consumerClientAgentRoomReconcile: typeof consumerClientAgentRoomReconcile;
  readonly consumerClientAgentRoomBootstrap: {
    readonly startedTotal: number;
    readonly completedTotal: number;
    readonly failedTotal: number;
    readonly pending: number;
    readonly durationSumMs: number;
    readonly durationAvgMs: number;
    readonly durationMaxMs: number;
    readonly fetchReusedTotal: number;
  };
  readonly profilePushRecipientFetch: typeof profilePushRecipientFetch;
  readonly roomDisconnect: typeof roomDisconnect;
  readonly consumerIdleTimeoutDisconnectTotal: number;
  readonly publishRecipientsHistogram: {
    readonly cumulativeBuckets: readonly { readonly le: string; readonly count: number }[];
    readonly sum: number;
    readonly count: number;
  };
  readonly profilePush: {
    readonly batchesTotal: number;
    readonly coalescedTotal: number;
    readonly fanoutTotal: number;
    readonly fanoutAvg: number;
    readonly fanoutMax: number;
  };
} => ({
  activeConnections: { ...activeConnections },
  authRejects: { ...authRejects },
  guardDb: {
    count: guardDb.count,
    sumMs: guardDb.sumMs,
    avgMs: guardDb.count > 0 ? Number((guardDb.sumMs / guardDb.count).toFixed(4)) : 0,
    maxMs: guardDb.maxMs,
  },
  commandAbort: { ...commandAbort },
  retryAfter: { ...retryAfter },
  relayOptIns: { ...relayOptInsCounters },
  customEvents: { ...customEvents },
  consumerClientAgentRoomGrant: { ...consumerClientAgentRoomGrant },
  consumerClientAgentRoomReconcile: { ...consumerClientAgentRoomReconcile },
  consumerClientAgentRoomBootstrap: {
    startedTotal: consumerClientAgentRoomBootstrap.startedTotal,
    completedTotal: consumerClientAgentRoomBootstrap.completedTotal,
    failedTotal: consumerClientAgentRoomBootstrap.failedTotal,
    pending: consumerClientAgentRoomBootstrap.pending,
    durationSumMs: consumerClientAgentRoomBootstrap.durationSumMs,
    durationAvgMs:
      consumerClientAgentRoomBootstrap.completedTotal > 0
        ? Number(
            (
              consumerClientAgentRoomBootstrap.durationSumMs /
              consumerClientAgentRoomBootstrap.completedTotal
            ).toFixed(4),
          )
        : 0,
    durationMaxMs: consumerClientAgentRoomBootstrap.durationMaxMs,
    fetchReusedTotal: consumerClientAgentRoomBootstrap.fetchReusedTotal,
  },
  profilePushRecipientFetch: { ...profilePushRecipientFetch },
  roomDisconnect: { ...roomDisconnect },
  consumerIdleTimeoutDisconnectTotal,
  publishRecipientsHistogram: {
    cumulativeBuckets: [
      ...PUBLISH_RECIPIENT_HIST_UPPER_BOUNDS.map((b) => ({
        le: String(b),
        count: publishRecipientsHistBuckets.get(b) ?? 0,
      })),
      { le: "+Inf", count: publishRecipientsHistInf },
    ],
    sum: publishRecipientsHistSum,
    count: publishRecipientsHistCount,
  },
  profilePush: {
    batchesTotal: profilePush.batchesTotal,
    coalescedTotal: profilePush.coalescedTotal,
    fanoutTotal: profilePush.fanoutTotal,
    fanoutAvg:
      profilePush.batchesTotal > 0
        ? Number((profilePush.fanoutTotal / profilePush.batchesTotal).toFixed(4))
        : 0,
    fanoutMax: profilePush.fanoutMax,
  },
});

export const resetSocketConsumerMetrics = (): void => {
  activeConnections.user = 0;
  activeConnections.client = 0;
  activeConnections.unknown = 0;
  authRejects.missing_token = 0;
  authRejects.invalid_token = 0;
  authRejects.role_denied = 0;
  authRejects.blocked_account = 0;
  guardDb.count = 0;
  guardDb.sumMs = 0;
  guardDb.maxMs = 0;
  commandAbort.abortedCommandsTotal = 0;
  retryAfter.socketErrorRetryAfterMsTotal = 0;
  retryAfter.agentsCommandRetryAfterSecondsTotal = 0;
  relayOptInsCounters.fastPathRequestedTotal = 0;
  relayOptInsCounters.fastPathHonoredTotal = 0;
  relayOptInsCounters.fastPathFallbackDedupTotal = 0;
  relayOptInsCounters.fastPathFallbackErrorTotal = 0;
  relayOptInsCounters.fastPathStreamInadvertentTotal = 0;
  relayOptInsCounters.fastPathForbiddenTotal = 0;
  relayOptInsCounters.conversationStartRemoteHubTotal = 0;
  relayOptInsCounters.bodyIdEchoTotal = 0;
  relayOptInsCounters.bodyIdEchoOverheadSumMs = 0;
  relayOptInsCounters.bodyIdEchoOverheadMaxMs = 0;
  relayOptInsCounters.serverTimingsRelayOptInTotal = 0;
  relayOptInsCounters.serverTimingsAgentsCommandOptInTotal = 0;
  relayOptInsCounters.serverTimingsRestOptInTotal = 0;
  relayOptInsCounters.lateResponseAfterTimeoutTotal = 0;
  relayOptInsCounters.relayOutboundJobFailureNotifiedTotal = 0;
  relayOptInsCounters.batchEnvelopesReceivedTotal = 0;
  relayOptInsCounters.batchEnvelopesAcceptedTotal = 0;
  relayOptInsCounters.batchItemsAcceptedTotal = 0;
  relayOptInsCounters.batchItemsDedupedTotal = 0;
  relayOptInsCounters.batchItemsErrorTotal = 0;
  for (const reason of Object.keys(
    relayOptInsCounters.batchEnvelopesRejectedTotal,
  ) as RelayBatchRejectReason[]) {
    relayOptInsCounters.batchEnvelopesRejectedTotal[reason] = 0;
  }
  profilePush.batchesTotal = 0;
  profilePush.coalescedTotal = 0;
  profilePush.fanoutTotal = 0;
  profilePush.fanoutMax = 0;
  customEvents.subscriptionsActive = 0;
  customEvents.subscribedTotal = 0;
  customEvents.unsubscribedTotal = 0;
  customEvents.subscriptionRejectedTotal = 0;
  customEvents.subscriptionForbiddenTotal = 0;
  customEvents.publishAcceptedTotal = 0;
  customEvents.publishRejectedTotal = 0;
  customEvents.publishIdempotentReplayTotal = 0;
  customEvents.publishRecipientsTotal = 0;
  customEvents.publishAttachmentBytesTotal = 0;
  customEvents.publishViaSocketTotal = 0;
  customEvents.publishIdempotencySerializationCapRejectedTotal = 0;
  customEvents.publishDistributedRecipientCountFailedTotal = 0;
  customEvents.publishDistributedRecipientCountSkippedTotal = 0;
  customEvents.publishDistributedRecipientCountCircuitOpenedTotal = 0;
  customEvents.publishDistributedRecipientCountCircuitRejectedTotal = 0;
  customEvents.publishDistributedRecipientCountCircuitOpen = 0;
  customEvents.publishRecipientCountBestEffortTotal = 0;
  customEvents.publishRecipientCapUnverifiedTotal = 0;
  customEvents.publishFetchSocketsDedupesTotal = 0;
  consumerClientAgentRoomGrant.attemptsTotal = 0;
  consumerClientAgentRoomGrant.socketsJoinedTotal = 0;
  consumerClientAgentRoomGrant.joinFailuresTotal = 0;
  consumerClientAgentRoomGrant.fetchFailuresTotal = 0;
  consumerClientAgentRoomReconcile.runsTotal = 0;
  consumerClientAgentRoomReconcile.clientsEvaluatedTotal = 0;
  consumerClientAgentRoomReconcile.clientsDeferredTotal = 0;
  consumerClientAgentRoomReconcile.socketsEvaluatedTotal = 0;
  consumerClientAgentRoomReconcile.roomsJoinedTotal = 0;
  consumerClientAgentRoomReconcile.roomsLeftTotal = 0;
  consumerClientAgentRoomReconcile.failuresTotal = 0;
  consumerClientAgentRoomReconcile.ticksSkippedTotal = 0;
  consumerClientAgentRoomReconcile.inFlight = 0;
  consumerClientAgentRoomBootstrap.startedTotal = 0;
  consumerClientAgentRoomBootstrap.completedTotal = 0;
  consumerClientAgentRoomBootstrap.failedTotal = 0;
  consumerClientAgentRoomBootstrap.pending = 0;
  consumerClientAgentRoomBootstrap.durationSumMs = 0;
  consumerClientAgentRoomBootstrap.durationMaxMs = 0;
  consumerClientAgentRoomBootstrap.fetchReusedTotal = 0;
  profilePushRecipientFetch.reusedInFlightTotal = 0;
  roomDisconnect.agentTriggeredTotal = 0;
  roomDisconnect.consumerTriggeredTotal = 0;
  consumerIdleTimeoutDisconnectTotal = 0;
  publishRecipientsHistSum = 0;
  publishRecipientsHistCount = 0;
  publishRecipientsHistBuckets.clear();
  publishRecipientsHistInf = 0;
};
