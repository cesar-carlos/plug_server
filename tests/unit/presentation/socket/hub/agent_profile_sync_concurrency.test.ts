import { describe, expect, it } from "vitest";

import {
  acquireAgentProfileSyncSlot,
  resetAgentProfileSyncConcurrency,
} from "../../../../../src/presentation/socket/hub/agent_profile_sync_concurrency";
import { env } from "../../../../../src/shared/config/env";

describe("agent_profile_sync_concurrency", () => {
  it("limits concurrent acquires to SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT", async () => {
    resetAgentProfileSyncConcurrency();
    const original = env.socketAgentProfileSyncMaxConcurrent;
    Object.defineProperty(env, "socketAgentProfileSyncMaxConcurrent", {
      value: 2,
      configurable: true,
    });

    try {
      const r1 = await acquireAgentProfileSyncSlot();
      const r2 = await acquireAgentProfileSyncSlot();
      const third = acquireAgentProfileSyncSlot();

      let thirdDone = false;
      void third.then(() => {
        thirdDone = true;
      });

      await new Promise((r) => setTimeout(r, 15));
      expect(thirdDone).toBe(false);

      r1();
      await third;
      expect(thirdDone).toBe(true);

      r2();
      (await acquireAgentProfileSyncSlot())();
    } finally {
      Object.defineProperty(env, "socketAgentProfileSyncMaxConcurrent", {
        value: original,
        configurable: true,
      });
    }
  });
});
