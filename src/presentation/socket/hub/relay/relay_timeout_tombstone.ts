import { env } from "../../../../shared/config/env";
import { noteRelayLateResponseAfterTimeout } from "../../../../shared/metrics/socket_consumer.metrics";

type RelayTimeoutTombstone = {
  readonly conversationId: string;
  readonly timedOutAtMs: number;
};

const tombstonesByRequestId = new Map<string, RelayTimeoutTombstone>();

const tombstoneTtlMs = (): number =>
  Math.max(env.socketRelayRequestTimeoutMs, env.socketRelayIdempotencyCleanupIntervalMs);

export const recordRelayTimeoutTombstone = (
  requestId: string,
  conversationId: string,
  nowEpochMs = Date.now(),
): void => {
  tombstonesByRequestId.set(requestId, { conversationId, timedOutAtMs: nowEpochMs });
};

export const noteRelayLateResponseIfTimedOut = (
  candidateIds: readonly string[],
  nowEpochMs = Date.now(),
): void => {
  for (const requestId of candidateIds) {
    const tombstone = tombstonesByRequestId.get(requestId);
    if (tombstone && nowEpochMs - tombstone.timedOutAtMs <= tombstoneTtlMs()) {
      noteRelayLateResponseAfterTimeout();
      return;
    }
  }
};

export const sweepRelayTimeoutTombstones = (nowEpochMs = Date.now()): void => {
  const ttlMs = tombstoneTtlMs();
  for (const [requestId, tombstone] of tombstonesByRequestId.entries()) {
    if (nowEpochMs - tombstone.timedOutAtMs > ttlMs) {
      tombstonesByRequestId.delete(requestId);
    }
  }
};

export const resetRelayTimeoutTombstonesForTests = (): void => {
  tombstonesByRequestId.clear();
};
