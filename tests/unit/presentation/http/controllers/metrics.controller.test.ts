import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Response } from "express";

import { getMetrics } from "../../../../../src/presentation/http/controllers/metrics.controller";

const mockGetSnapshot = vi.fn();

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    socketMetricsSnapshotProvider: {
      getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    },
  },
}));

describe("metrics.controller", () => {
  beforeEach(() => {
    mockGetSnapshot.mockReset();
    mockGetSnapshot.mockReturnValue({
      namespaces: { agents: 1, consumers: 2 },
      relay: {
        counters: {
          requestsAccepted: 0,
          requestsDeduplicated: 0,
          responsesForwarded: 0,
          chunksForwarded: 0,
          chunksBuffered: 0,
          chunksDropped: 0,
          streamTerminalCompletions: 0,
          streamIdleTimeouts: 0,
          streamLifetimeTimeouts: 0,
          streamDispatchSlotsReleasedOnOpen: 0,
          streamPulls: 0,
          restSqlStreamMaterializePulls: 0,
          restSqlStreamMaterializeCompleted: 0,
          restSqlStreamMaterializeRowsMerged: 0,
          restMaterializeRowLimitExceeded: 0,
          restMaterializeChunkLimitExceeded: 0,
          restMaterializeByteLimitExceeded: 0,
          restMaterializeActiveStreamLimitExceeded: 0,
          requestTimeouts: 0,
          ackRetryAttempts: 0,
          ackRetryAttemptsByPath: { rest: 0, relay: 0 },
          ackRetryExhausted: 0,
          ackRetryExhaustedByPath: { rest: 0, relay: 0 },
          circuitOpenRejects: 0,
          restGlobalPendingCapRejected: 0,
          restAgentQueueFullRejected: 0,
          restAgentQueueWaitTimeoutRejected: 0,
          rpcFrameDecodeFailed: 0,
          relayEmitDiscardedConsumerGone: 0,
          conversationsExpiredTotal: 0,
          overloadChecksTotal: 0,
          overloadCheckSumMs: 0,
          frameDecodeCount: 0,
          frameDecodeSumMs: 0,
          commandValidateCount: 0,
          commandValidateSumMs: 0,
          bridgeEncodeCount: 0,
          bridgeEncodeSumMs: 0,
          chunkForwardJobCount: 0,
          chunkForwardJobSumMs: 0,
          bufferDrainRunCount: 0,
          bufferDrainSumMs: 0,
        },
        gauges: {
          pendingRelayRequests: 0,
          pendingRestRequests: 0,
          activeStreams: 0,
          restMaterializeStreamsInFlight: 0,
          bufferedChunks: 0,
          openCircuits: 0,
        },
        restAgentDispatchQueue: {
          totalInflight: 0,
          totalQueuedWaiters: 0,
          agentsWithQueuedWaiters: 0,
          maxQueueDepthPerAgent: 0,
        },
        relayAgentDispatchQueue: {
          totalInflight: 0,
          totalQueuedWaiters: 0,
          agentsWithQueuedWaiters: 0,
          maxQueueDepthPerAgent: 0,
          queueFullRejected: 0,
          queueWaitTimeoutRejected: 0,
        },
        relayOutboundQueue: {
          jobsEnqueuedTotal: 0,
          jobsFinishedTotal: 0,
          jobsFailedTotal: 0,
          overloadRejectedTotal: 0,
          orphanedTailsSweptTotal: 0,
          jobDurationSumMs: 0,
          jobDurationAvgMs: 0,
          jobDurationMaxMs: 0,
          jobDurationP95Ms: 0,
          jobDurationP99Ms: 0,
          inflightRequestIds: 0,
          backlog: 0,
          orphanedRequestIds: 0,
          overloadStateRefreshTotal: 0,
          overloadCacheP95Ms: 0,
        },
        latencyByAgent: [],
      },
      relayRateLimit: {
        windowMs: 0,
        maxConversationStarts: 0,
        maxRequests: 0,
        activeIdentitiesTracked: 0,
        maxAgentsStreamPullCredits: 0,
        counters: {
          conversationStartAllowedUser: 0,
          conversationStartAllowedAnon: 0,
          conversationStartRejectedUser: 0,
          conversationStartRejectedAnon: 0,
          relayRequestAllowedUser: 0,
          relayRequestAllowedAnon: 0,
          relayRequestRejectedUser: 0,
          relayRequestRejectedAnon: 0,
          streamPullCreditsGrantedUser: 0,
          streamPullCreditsGrantedAnon: 0,
          streamPullCreditsRejectedUser: 0,
          streamPullCreditsRejectedAnon: 0,
          agentsStreamPullCreditsGrantedUser: 0,
          agentsStreamPullCreditsGrantedAnon: 0,
          agentsStreamPullCreditsRejectedUser: 0,
          agentsStreamPullCreditsRejectedAnon: 0,
        },
      },
      socketRateLimitRedis: {
        redisUrlConfigured: 0,
        redisStoreActive: 0,
        fallbackEventsTotal: 0,
        runtimeCommandErrorEventsTotal: 0,
        connectionEventsTotal: 0,
        circuitOpen: 0,
        circuitOpenedTotal: 0,
        lastFallbackAtMs: 0,
        lastConnectionAtMs: 0,
        redisAllowedTotal: 0,
        redisRejectedTotal: 0,
        windowResetsTotal: 0,
        saturationsTotal: 0,
        trackedKeysWindowSize: 0,
        trackedKeysSeenTotal: 0,
        latency: {
          consume: { buckets: [], count: 0, sumMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
          refund: { buckets: [], count: 0, sumMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
        },
      },
      agentsCommandSocketRateLimit: {
        windowMs: 0,
        maxPerWindow: 0,
        weightedCosts: false,
        trackedKeys: 0,
        allowedTotal: 0,
        rejectedTotal: 0,
      },
      clientSocketEventPublishSocketRateLimit: {
        windowMs: 0,
        maxPerWindow: 0,
        trackedKeys: 0,
        allowedTotal: 0,
        rejectedTotal: 0,
      },
      consumerRuntime: {
        activeConnections: { user: 0, client: 0, unknown: 0 },
        authRejects: {
          missing_token: 0,
          invalid_token: 0,
          role_denied: 0,
          blocked_account: 0,
        },
        guardDb: { count: 0, avgMs: 0, maxMs: 0 },
        commandAbort: { abortedCommandsTotal: 0 },
        retryAfter: {
          socketErrorRetryAfterMsTotal: 0,
          agentsCommandRetryAfterSecondsTotal: 0,
        },
        relayOptIns: {
          fastPathRequestedTotal: 0,
          fastPathHonoredTotal: 0,
          fastPathFallbackDedupTotal: 0,
          fastPathFallbackErrorTotal: 0,
          fastPathStreamInadvertentTotal: 0,
          serverTimingsRelayOptInTotal: 0,
          serverTimingsAgentsCommandOptInTotal: 0,
          serverTimingsRestOptInTotal: 0,
          batchEnvelopesReceivedTotal: 0,
          batchEnvelopesAcceptedTotal: 0,
          batchItemsAcceptedTotal: 0,
          batchItemsDedupedTotal: 0,
          batchItemsErrorTotal: 0,
          batchEnvelopesRejectedTotal: {
            disabled: 0,
            not_found: 0,
            frame_decode_failed: 0,
            not_array: 0,
            validation_failed: 0,
            inflight_gate: 0,
            envelope_error: 0,
          },
        },
        customEvents: {
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
        },
        consumerClientAgentRoomGrant: {
          attemptsTotal: 0,
          socketsJoinedTotal: 0,
          joinFailuresTotal: 0,
          fetchFailuresTotal: 0,
        },
        consumerClientAgentRoomReconcile: {
          runsTotal: 0,
          clientsEvaluatedTotal: 0,
          clientsDeferredTotal: 0,
          socketsEvaluatedTotal: 0,
          roomsJoinedTotal: 0,
          roomsLeftTotal: 0,
          failuresTotal: 0,
          ticksSkippedTotal: 0,
          inFlight: 0,
        },
        consumerClientAgentRoomBootstrap: {
          startedTotal: 0,
          completedTotal: 0,
          failedTotal: 0,
          pending: 0,
          durationSumMs: 0,
          durationAvgMs: 0,
          durationMaxMs: 0,
          fetchReusedTotal: 0,
        },
        profilePushRecipientFetch: { reusedInFlightTotal: 0 },
        roomDisconnect: { agentTriggeredTotal: 0, consumerTriggeredTotal: 0 },
        consumerIdleTimeoutDisconnectTotal: 0,
        publishRecipientsHistogram: { cumulativeBuckets: [], sum: 0, count: 0 },
        profilePush: {
          batchesTotal: 0,
          coalescedTotal: 0,
          fanoutAvg: 0,
          fanoutMax: 0,
        },
      },
      agentRuntime: {
        authRejects: {
          missing_token: 0,
          invalid_token: 0,
          role_denied: 0,
          blocked_account: 0,
          account_validation_error: 0,
        },
        sessionRejectedActiveTotal: 0,
        sessionTakeoverDisconnectTotal: 0,
        agentIdleTimeoutDisconnectTotal: 0,
        sessionRegisterRateLimitedTotal: 0,
        agentReadyLegacyPayloadTotal: 0,
        agentReadyInvalidPartialPayloadTotal: 0,
        inboundContractValidation: { failedTotal: 0, warnTotal: 0 },
        capabilityProfiles: { current: 0, older: 0, unknown: 0 },
        capabilityAgentGetHealthCapableTotal: 0,
        agentHealth: {
          responsesTotal: 0,
          errorsTotal: 0,
          lastSeenAtMs: 0,
          lastHealthy: 0,
          lastDegraded: 0,
          lastUptimeSeconds: 0,
          lastSqlQueueCurrentSize: 0,
          lastSqlQueueMaxSize: 0,
          lastActiveWorkers: 0,
          lastMaxWorkers: 0,
          lastSqlQueueRejectionsTotal: 0,
          lastSqlQueueTimeoutsTotal: 0,
          lastSqlQueueAvgWaitTimeMs: 0,
          lastQueryTotal: 0,
          lastQueryErrors: 0,
          lastQuerySuccessRate: 0,
          lastAvgLatencyMs: 0,
          lastP95LatencyMs: 0,
          lastP99LatencyMs: 0,
        },
      },
      hubErrors: {
        engineConnectionErrors: {
          unsupported_protocol: 0,
          bad_request: 0,
          unknown: 0,
        },
        namespaceAdapterErrors: {},
        namespaceSocketErrors: {},
      },
    });
  });

  it("should read socket metrics through the DI provider", () => {
    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as unknown as Response;

    getMetrics({} as never, response);

    expect(mockGetSnapshot).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(200);
    /**
     * `metrics.controller` now caches the rendered body as a `Buffer` to
     * skip UTF-8 re-encoding on warm hits; decode here so the assertions
     * remain string-based and human-readable.
     */
    const sendCalls = (response.send as ReturnType<typeof vi.fn>).mock.calls;
    const sendArg = sendCalls[0]?.[0];
    const body = Buffer.isBuffer(sendArg) ? sendArg.toString("utf-8") : String(sendArg);
    expect(body).toContain("plug_socket_namespace_connections");
    expect(body).toContain('plug_socket_bridge_ack_retry_attempts_total{path="rest"} 0');
    expect(body).toContain('plug_socket_bridge_ack_retry_exhausted_total{path="relay"} 0');
    expect(body).toContain("plug_agent_idle_timeout_disconnect_total");
    expect(body).toContain("plug_consumer_idle_timeout_disconnect_total");
    expect(body).toContain('plug_socket_engine_connection_errors_total{code="unknown"} 0');
  });
});
