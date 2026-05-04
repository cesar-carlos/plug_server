import { env } from "../../../shared/config/env";

const waitQueue: Array<() => void> = [];

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
      active -= 1;
      waitQueue.shift()?.();
    };
  }
  await new Promise<void>((resolve) => {
    waitQueue.push(resolve);
  });
  active += 1;
  return (): void => {
    active -= 1;
    waitQueue.shift()?.();
  };
};

/** Clears wait queue and in-flight accounting (e.g. hub shutdown / tests). */
export const resetAgentProfileSyncConcurrency = (): void => {
  waitQueue.length = 0;
  active = 0;
};
