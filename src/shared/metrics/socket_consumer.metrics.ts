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

const profilePush = {
  batchesTotal: 0,
  coalescedTotal: 0,
  fanoutTotal: 0,
  fanoutMax: 0,
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
  profilePush.batchesTotal = 0;
  profilePush.coalescedTotal = 0;
  profilePush.fanoutTotal = 0;
  profilePush.fanoutMax = 0;
};
