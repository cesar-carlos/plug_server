import { env } from "../../../../shared/config/env";

type RelayStreamTimeoutReason = "idle" | "lifetime";

interface RelayStreamTimeoutEntry {
  idleHandle: NodeJS.Timeout | null;
  lifetimeHandle: NodeJS.Timeout | null;
  onTimeout: (reason: RelayStreamTimeoutReason) => void;
}

const timeoutByRequestId = new Map<string, RelayStreamTimeoutEntry>();

const armIdleTimer = (requestId: string, entry: RelayStreamTimeoutEntry): void => {
  if (entry.idleHandle) {
    clearTimeout(entry.idleHandle);
  }
  entry.idleHandle = setTimeout(() => {
    entry.idleHandle = null;
    entry.onTimeout("idle");
  }, env.socketRelayStreamIdleTimeoutMs);
  entry.idleHandle.unref?.();
};

export const registerRelayStreamTimeouts = (
  requestId: string,
  onTimeout: (reason: RelayStreamTimeoutReason) => void,
): void => {
  clearRelayStreamTimeouts(requestId);

  const entry: RelayStreamTimeoutEntry = {
    idleHandle: null,
    lifetimeHandle: null,
    onTimeout,
  };
  timeoutByRequestId.set(requestId, entry);
  armIdleTimer(requestId, entry);

  entry.lifetimeHandle = setTimeout(() => {
    entry.lifetimeHandle = null;
    entry.onTimeout("lifetime");
  }, env.socketRelayStreamMaxLifetimeMs);
  entry.lifetimeHandle.unref?.();
};

export const touchRelayStreamTimeout = (requestId: string): void => {
  const entry = timeoutByRequestId.get(requestId);
  if (!entry) {
    return;
  }
  armIdleTimer(requestId, entry);
};

export const clearRelayStreamTimeouts = (requestId: string): void => {
  const entry = timeoutByRequestId.get(requestId);
  if (!entry) {
    return;
  }
  if (entry.idleHandle) {
    clearTimeout(entry.idleHandle);
  }
  if (entry.lifetimeHandle) {
    clearTimeout(entry.lifetimeHandle);
  }
  timeoutByRequestId.delete(requestId);
};

export const resetRelayStreamTimeouts = (): void => {
  for (const requestId of timeoutByRequestId.keys()) {
    clearRelayStreamTimeouts(requestId);
  }
};
