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
  publishAcceptedTotal: 0,
  publishRejectedTotal: 0,
  publishIdempotentReplayTotal: 0,
  publishRecipientsTotal: 0,
  publishAttachmentBytesTotal: 0,
  publishViaSocketTotal: 0,
};

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

export const observeConsumerGuardDbValidation = (elapsedMs: number): void => {
  const safeElapsedMs = Math.max(0, elapsedMs);
  guardDb.count += 1;
  guardDb.sumMs += safeElapsedMs;
  guardDb.maxMs = Math.max(guardDb.maxMs, safeElapsedMs);
};

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
  readonly customEvents: typeof customEvents;
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
  customEvents: { ...customEvents },
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
  profilePush.batchesTotal = 0;
  profilePush.coalescedTotal = 0;
  profilePush.fanoutTotal = 0;
  profilePush.fanoutMax = 0;
  customEvents.subscriptionsActive = 0;
  customEvents.subscribedTotal = 0;
  customEvents.unsubscribedTotal = 0;
  customEvents.subscriptionRejectedTotal = 0;
  customEvents.publishAcceptedTotal = 0;
  customEvents.publishRejectedTotal = 0;
  customEvents.publishIdempotentReplayTotal = 0;
  customEvents.publishRecipientsTotal = 0;
  customEvents.publishAttachmentBytesTotal = 0;
  customEvents.publishViaSocketTotal = 0;
  publishRecipientsHistSum = 0;
  publishRecipientsHistCount = 0;
  publishRecipientsHistBuckets.clear();
  publishRecipientsHistInf = 0;
};
