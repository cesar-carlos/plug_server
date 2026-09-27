import { describe, expect, it } from "vitest";

import { agentHubPresenceKey } from "../../../../../src/infrastructure/redis/presence/agent_hub_presence_keys";
import {
  AGENT_HUB_PRESENCE_RESOLVE_ROUTES_CHUNK_SIZE,
  resolvePresenceRoutesWithMget,
} from "../../../../../src/infrastructure/redis/presence/agent_hub_presence_resolve_routes";

const serialize = (hubInstanceId: string): string =>
  JSON.stringify({
    hubInstanceId,
    socketId: "socket-1",
    connectedAtMs: 1,
    lastSeenAtMs: 1,
  });

describe("resolvePresenceRoutesWithMget", () => {
  it.each([1, 100, 1_000, 10_000])(
    "loads %s ids with chunked MGET instead of per-id round trips",
    async (count) => {
      const ids = Array.from({ length: count }, (_, index) => `agent-${index}`);
      const keyToId = new Map(ids.map((id) => [agentHubPresenceKey(id), id] as const));
      let mgetCalls = 0;
      let keysSeen = 0;
      const routes = await resolvePresenceRoutesWithMget(ids, async (keys) => {
        mgetCalls += 1;
        keysSeen += keys.length;
        return keys.map((key) => (keyToId.has(key) ? serialize("hub-a") : null));
      });
      const expectedCalls = Math.ceil(count / AGENT_HUB_PRESENCE_RESOLVE_ROUTES_CHUNK_SIZE);
      expect(mgetCalls).toBe(expectedCalls);
      expect(keysSeen).toBe(count);
      expect(routes.size).toBe(count);
    },
  );
});
