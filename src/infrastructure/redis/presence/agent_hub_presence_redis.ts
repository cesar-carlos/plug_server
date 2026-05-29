import { performance } from "node:perf_hooks";

import type { AgentHubPresencePort, AgentHubPresenceRecord } from "../../../domain/ports/agent_hub_presence.port";
import {
  noteAgentHubPresenceConnected,
  noteAgentHubPresenceDisconnected,
  noteAgentHubPresenceFallback,
  noteAgentHubPresenceSkippedEmptyUrl,
  observeAgentHubPresenceRedisLatency,
} from "../../../application/services/agent_hub_presence_redis_metrics.service";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";
import { validateRedisClusterTopology } from "../cluster/cluster_topology_validator";
import { createManagedRedisConnection } from "../connection/managed_redis_connection";
import {
  createPubSubInstrumentedRedisClients,
  type PubSubInstrumentedRedisClients,
} from "../connection/pubsub_instrumented_redis_client";
import { buildResilientRedisClientOptions } from "../connection/redis_client_options";
import type { InstrumentedRedisClient } from "../connection/instrumented_redis_client";
import {
  agentHubBridgeCmdChannel,
  agentHubBridgeReplyChannel,
  agentHubPresenceKey,
} from "./agent_hub_presence_keys";

const dataConnection = createManagedRedisConnection();
let pubSubClients: PubSubInstrumentedRedisClients | undefined;
let pubSubUrlInUse: string | undefined;
let pubSubGeneration = 0;
let bridgeCommandHandler: ((message: string) => void) | undefined;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const presenceTtlSeconds = (): number =>
  Math.max(1, Math.ceil(env.agentHubPresenceTtlMs / 1000));

const recordCommandLatency = async <T>(fn: () => Promise<T>): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    observeAgentHubPresenceRedisLatency(performance.now() - startedAt);
  }
};

const getDataClient = (): InstrumentedRedisClient | undefined => dataConnection.getClient();

const parsePresenceRecord = (raw: string): AgentHubPresenceRecord | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.hubInstanceId !== "string" ||
      typeof record.socketId !== "string" ||
      typeof record.connectedAtMs !== "number" ||
      typeof record.lastSeenAtMs !== "number"
    ) {
      return null;
    }
    return {
      hubInstanceId: record.hubInstanceId,
      socketId: record.socketId,
      connectedAtMs: record.connectedAtMs,
      lastSeenAtMs: record.lastSeenAtMs,
    };
  } catch {
    return null;
  }
};

const serializePresenceRecord = (record: AgentHubPresenceRecord): string =>
  JSON.stringify(record);

class AgentHubPresenceRedis implements AgentHubPresencePort {
  readonly isEnabled: boolean;

  constructor(enabled: boolean) {
    this.isEnabled = enabled;
  }

  async upsert(
    agentId: string,
    input: Omit<AgentHubPresenceRecord, "lastSeenAtMs"> & { readonly lastSeenAtMs?: number },
  ): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    const client = getDataClient();
    if (client === undefined) {
      return;
    }
    const nowMs = Date.now();
    const record: AgentHubPresenceRecord = {
      hubInstanceId: input.hubInstanceId,
      socketId: input.socketId,
      connectedAtMs: input.connectedAtMs,
      lastSeenAtMs: input.lastSeenAtMs ?? nowMs,
    };
    await recordCommandLatency(() =>
      client.set(agentHubPresenceKey(agentId), serializePresenceRecord(record), {
        EX: presenceTtlSeconds(),
      }),
    );
  }

  async touch(agentId: string): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    const client = getDataClient();
    if (client === undefined) {
      return;
    }
    const key = agentHubPresenceKey(agentId);
    await recordCommandLatency(async () => {
      const raw = await client.get(key);
      if (raw === null) {
        return;
      }
      const existing = parsePresenceRecord(raw);
      if (existing === null) {
        return;
      }
      const updated: AgentHubPresenceRecord = {
        ...existing,
        lastSeenAtMs: Date.now(),
      };
      await client.set(key, serializePresenceRecord(updated), { EX: presenceTtlSeconds() });
    });
  }

  async removeIfHubInstanceMatches(agentId: string, hubInstanceId: string): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    const client = getDataClient();
    if (client === undefined) {
      return;
    }
    const key = agentHubPresenceKey(agentId);
    await recordCommandLatency(async () => {
      const raw = await client.get(key);
      if (raw === null) {
        return;
      }
      const existing = parsePresenceRecord(raw);
      if (existing === null || existing.hubInstanceId !== hubInstanceId) {
        return;
      }
      await client.del(key);
    });
  }

  async removeIfSocketMatches(agentId: string, socketId: string): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    const client = getDataClient();
    if (client === undefined) {
      return;
    }
    const key = agentHubPresenceKey(agentId);
    await recordCommandLatency(async () => {
      const raw = await client.get(key);
      if (raw === null) {
        return;
      }
      const existing = parsePresenceRecord(raw);
      if (existing === null || existing.socketId !== socketId) {
        return;
      }
      await client.del(key);
    });
  }

  async resolveRoute(agentId: string): Promise<{ readonly hubInstanceId: string } | null> {
    if (!this.isEnabled) {
      return null;
    }
    const client = getDataClient();
    if (client === undefined) {
      return null;
    }
    const raw = await recordCommandLatency(() => client.get(agentHubPresenceKey(agentId)));
    if (raw === null) {
      return null;
    }
    const record = parsePresenceRecord(raw);
    if (record === null) {
      return null;
    }
    return { hubInstanceId: record.hubInstanceId };
  }
}

let presencePort: AgentHubPresencePort = new AgentHubPresenceRedis(false);

export const getAgentHubPresencePort = (): AgentHubPresencePort => presencePort;

export const publishBridgeCommand = async (
  targetHubInstanceId: string,
  payload: string,
): Promise<boolean> => {
  const pub = pubSubClients?.pub;
  if (pub === undefined) {
    return false;
  }
  const channel = agentHubBridgeCmdChannel(targetHubInstanceId);
  await recordCommandLatency(() => pub.publish(channel, payload));
  return true;
};

export const publishBridgeReply = async (correlationId: string, payload: string): Promise<boolean> => {
  const pub = pubSubClients?.pub;
  if (pub === undefined) {
    return false;
  }
  const channel = agentHubBridgeReplyChannel(correlationId);
  await recordCommandLatency(() => pub.publish(channel, payload));
  return true;
};

export const waitForBridgeReply = (correlationId: string, timeoutMs: number): Promise<string> => {
  const sub = pubSubClients?.sub;
  if (sub === undefined) {
    return Promise.reject(new Error("Bridge forward Redis subscriber unavailable"));
  }

  const replyChannel = agentHubBridgeReplyChannel(correlationId);

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void sub.unsubscribe(replyChannel).catch(() => undefined);
      fn();
    };

    const listener = (message: string): void => {
      finish(() => resolve(message));
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("Bridge forward reply timed out")));
    }, timeoutMs);
    timer.unref?.();

    void sub.subscribe(replyChannel, listener).catch((error: unknown) => {
      finish(() =>
        reject(error instanceof Error ? error : new Error("Bridge forward subscribe failed")),
      );
    });
  });
};

const subscribeBridgeCommandChannel = (): void => {
  const hubInstanceId = env.hubInstanceId.trim();
  const sub = pubSubClients?.sub;
  if (sub === undefined || hubInstanceId === "") {
    if (hubInstanceId === "") {
      logger.warn("agent_hub_bridge_subscribe_skipped_empty_hub_instance_id");
    }
    return;
  }
  const channel = agentHubBridgeCmdChannel(hubInstanceId);
  void sub.subscribe(channel, (message) => {
    bridgeCommandHandler?.(message);
  }).catch((error: unknown) => {
    logger.error("agent_hub_bridge_subscribe_failed", {
      channel,
      message: toSafeErrorMessage(error),
    });
  });
};

export const startBridgeCommandSubscriber = (handler: (message: string) => void): void => {
  bridgeCommandHandler = handler;
  subscribeBridgeCommandChannel();
};

export async function initAgentHubPresenceRedis(): Promise<void> {
  const url = env.agentHubPresenceRedisUrl.trim();
  if (!env.agentHubPresenceEnabled || url === "") {
    await closeAgentHubPresenceRedis();
    presencePort = new AgentHubPresenceRedis(false);
    noteAgentHubPresenceSkippedEmptyUrl();
    logger.info("agent_hub_presence_redis_skipped", {
      reason: env.agentHubPresenceEnabled ? "AGENT_HUB_PRESENCE_REDIS_URL empty" : "disabled",
    });
    return;
  }

  if (dataConnection.isConnectedTo(url) && pubSubClients !== undefined && pubSubUrlInUse === url) {
    presencePort = new AgentHubPresenceRedis(true);
    subscribeBridgeCommandChannel();
    return;
  }

  await closeAgentHubPresenceRedis();

  const dataResult = await dataConnection.connect({
    url,
    logName: "agent_hub_presence_redis",
    buildCallbacks: (isCurrent) => ({
      onConnected: () => {
        if (!isCurrent()) {
          return;
        }
        noteAgentHubPresenceConnected();
        logger.info("agent_hub_presence_redis_connected");
      },
      onError: () => {
        if (!isCurrent()) {
          return;
        }
        noteAgentHubPresenceFallback();
      },
      onEnd: () => {
        if (!isCurrent()) {
          return;
        }
        noteAgentHubPresenceDisconnected();
      },
      onReadyAfterReconnect: () => {
        if (!isCurrent()) {
          return;
        }
        noteAgentHubPresenceConnected();
      },
      onFallback: (error: unknown) => {
        noteAgentHubPresenceFallback();
        logger.warn("agent_hub_presence_redis_fallback_memory", {
          message: toSafeErrorMessage(error),
        });
        presencePort = new AgentHubPresenceRedis(false);
      },
    }),
  });

  if (dataResult === undefined) {
    presencePort = new AgentHubPresenceRedis(false);
    return;
  }

  const generation = ++pubSubGeneration;
  const isPubSubCurrent = (): boolean => generation === pubSubGeneration;

  const pubSub = await createPubSubInstrumentedRedisClients({
    url,
    logName: "agent_hub_bridge_pubsub",
    buildClientOptions: () =>
      buildResilientRedisClientOptions({ url, logName: "agent_hub_bridge_pubsub" }),
    isCurrent: isPubSubCurrent,
    callbacks: {
      onConnected: () => {
        if (!isPubSubCurrent()) {
          return;
        }
        logger.info("agent_hub_bridge_pubsub_connected");
        subscribeBridgeCommandChannel();
      },
      onError: () => {
        if (!isPubSubCurrent()) {
          return;
        }
        noteAgentHubPresenceFallback();
      },
      onEnd: () => {
        if (!isPubSubCurrent()) {
          return;
        }
      },
      onFallback: (error: unknown) => {
        logger.warn("agent_hub_bridge_pubsub_fallback", {
          message: toSafeErrorMessage(error),
        });
      },
    },
  });

  if (pubSub === undefined) {
    await dataConnection.teardown();
    presencePort = new AgentHubPresenceRedis(false);
    return;
  }

  pubSubClients = pubSub;
  pubSubUrlInUse = url;
  presencePort = new AgentHubPresenceRedis(true);

  await validateRedisClusterTopology({
    client: dataResult.client,
    logName: "agent_hub_presence_redis",
    sampleKeys: [agentHubPresenceKey("probe"), agentHubBridgeCmdChannel("probe")],
  });

  subscribeBridgeCommandChannel();
}

export async function closeAgentHubPresenceRedis(): Promise<void> {
  pubSubGeneration += 1;
  if (pubSubClients !== undefined) {
    await pubSubClients.close();
    pubSubClients = undefined;
  }
  pubSubUrlInUse = undefined;
  await dataConnection.teardown();
  presencePort = new AgentHubPresenceRedis(false);
  noteAgentHubPresenceDisconnected();
}

export const isAgentHubPresenceRedisActive = (): boolean =>
  env.agentHubPresenceEnabled && getDataClient() !== undefined && pubSubClients !== undefined;
