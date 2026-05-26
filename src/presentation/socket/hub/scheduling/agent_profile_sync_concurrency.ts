import { env } from "../../../../shared/config/env";
import { serviceUnavailable } from "../../../../shared/errors/http_errors";

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const waitQueue: Waiter[] = [];

let active = 0;

/**
 * Limits concurrent `agent.getProfile` catalog sync RPCs after `agent:register`
 * to avoid stampedes when many agents reconnect at once.
 */
export const acquireAgentProfileSyncSlot = async (): Promise<() => void> => {
  const max = Math.max(1, Math.floor(env.socketAgentProfileSyncMaxConcurrent));
  if (active < max) {
    active += 1;
    return (): void => {
      active = Math.max(0, active - 1);
      waitQueue.shift()?.resolve();
    };
  }
  await new Promise<void>((resolve, reject) => {
    waitQueue.push({
      resolve,
      reject,
    });
  });
  active += 1;
  return (): void => {
    active = Math.max(0, active - 1);
    waitQueue.shift()?.resolve();
  };
};

/** Clears wait queue and in-flight accounting (e.g. hub shutdown / tests). */
export const resetAgentProfileSyncConcurrency = (): void => {
  const resetError = serviceUnavailable("Agent profile sync concurrency gate has been reset");
  for (const waiter of waitQueue.splice(0)) {
    waiter.reject(resetError);
  }
  waitQueue.length = 0;
  active = 0;
};
