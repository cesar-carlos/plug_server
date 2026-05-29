/**
 * Optional per-recipient Redis Streams buffer for at-least-once delivery of
 * `client:custom.*` frames across hub replicas. When `AGENT_EVENT_STREAM_ENABLED=true`,
 * every published frame is appended to a per-recipient stream so a subscriber
 * that reconnects (potentially to a different replica) can receive any frames
 * emitted while it was offline.
 *
 * Streams are bounded via `XADD MAXLEN ~ N` and auto-expire via `PEXPIRE`
 * after each append, so idle streams are GC'd without an explicit sweep.
 *
 * The Socket.IO Redis adapter (pub/sub) remains the fast online path: we use
 * Streams strictly as a durable backlog buffer.
 *
 * **Naming.** The module API uses `principalId` (consumer Client `JWT sub`)
 * for the recipient identifier. The key prefix `plug_agent_stream:` stays
 * unchanged for back-compat with data already at rest — see ADR-0003.
 */

import { performance } from "node:perf_hooks";

import { withRedisSpan } from "../observability/redis_span";
import { validateRedisClusterTopology } from "./cluster_topology_validator";
import type { InstrumentedRedisClient } from "./instrumented_redis_client";
import { createManagedRedisConnection } from "./managed_redis_connection";
import { redisKeyNamespace, sanitizeRedisKeySegment } from "./redis_key_namespace";
import {
  noteAgentEventStreamAck,
  noteAgentEventStreamAppend,
  noteAgentEventStreamBacklogRead,
  noteAgentEventStreamBatchAppend,
  noteAgentEventStreamBatchPartialFailure,
  noteAgentEventStreamCommandError,
  noteAgentEventStreamConnected,
  noteAgentEventStreamDisconnected,
  noteAgentEventStreamDropped,
  noteAgentEventStreamFallback,
  noteAgentEventStreamSkippedEmptyUrl,
  observeAgentEventStreamLatency,
} from "../../application/services/agent_event_stream_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

const connection = createManagedRedisConnection();

/**
 * Max recipients packed into a single `MULTI/EXEC` fan-out. Larger fan-outs
 * are split across multiple pipelined transactions so neither the client-side
 * command queue nor the server reply array grows unbounded.
 */
const XADD_PIPELINE_CHUNK_SIZE = 500;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sanitizePrincipalId = (principalId: string): string => sanitizeRedisKeySegment(principalId);

const streamKey = (principalId: string): string =>
  `plug_agent_stream:${redisKeyNamespace()}:${sanitizePrincipalId(principalId)}`;

/**
 * Schema version embedded in every appended frame. Bump when the shape of the
 * `AgentEventStreamFrame` payload changes (new required field, format change,
 * compression scheme). On read, frames with an unknown version are dropped
 * via `noteAgentEventStreamDropped()` so a future hub release does not deliver
 * data it cannot interpret.
 */
export const AGENT_EVENT_STREAM_FRAME_SCHEMA_VERSION = 1 as const;

export interface AgentEventStreamFrame {
  /** Unique frame id (e.g. `eventId` from the publish path). */
  readonly eventId: string;
  /** Logical event name, e.g. `client:custom.<scope>`. */
  readonly eventName: string;
  /** Iso-8601 emission timestamp from the publish path. */
  readonly emittedAt: string;
  /** Opaque, already-encoded payload. We do not re-decode/inspect this. */
  readonly payload: string;
}

export interface AgentEventStreamBacklogEntry extends AgentEventStreamFrame {
  /** Stream id (`<ms>-<seq>`) used for `XACK`/`XDEL` after delivery. */
  readonly streamId: string;
}

export const isAgentEventStreamActive = (): boolean =>
  connection.getClient() !== undefined && env.agentEventStreamEnabled;

/**
 * Internal accessor used by `agent_event_stream_cursor.ts` so the cursor
 * persistence reuses the same connection as the stream itself. Returns
 * `undefined` when the stream module is disabled / disconnected.
 */
export const getAgentEventStreamRedisClient = (): InstrumentedRedisClient | undefined =>
  connection.getClient();

const isPrincipalInAllowlist = (principalId: string): boolean => {
  const allowlist = env.agentEventStreamAgentAllowlist;
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.includes(principalId);
};

/**
 * Single-recipient append. Thin wrapper over {@link appendAgentEventFramesBatch}
 * for back-compat: existing callers that publish to one recipient at a time
 * keep their signature; the batch path is taken automatically (size 1).
 */
export const appendAgentEventFrame = async (
  principalId: string,
  frame: AgentEventStreamFrame,
): Promise<string | undefined> => {
  const results = await appendAgentEventFramesBatch([{ principalId, frame }]);
  return results[0];
};

export interface AgentEventStreamBatchEntry {
  readonly principalId: string;
  readonly frame: AgentEventStreamFrame;
}

/**
 * Pipelined fan-out append. Issues one `XADD` (and optional `PEXPIRE`) per
 * accepted entry inside a single `MULTI/EXEC` transaction so the whole fan-out
 * costs a single round-trip regardless of recipient count.
 *
 * Returns an array aligned 1:1 with `entries`: each slot holds the resulting
 * stream id for that entry, or `undefined` when the entry was skipped (client
 * not connected, stream disabled, principal not in allowlist) or its `XADD`
 * reply was not a valid stream id (rejected by the transaction).
 *
 * Failure semantics:
 *   - A global `EXEC` rejection (network drop, server error before the
 *     transaction starts) is logged once and returns `undefined` for every
 *     accepted entry — `noteAgentEventStreamCommandError` is bumped a single
 *     time so a fan-out with N recipients does not inflate the error counter.
 *   - Per-entry failures inside a successful `EXEC` (e.g. one of the `XADD`s
 *     replied with an error) increment `noteAgentEventStreamBatchPartialFailure(failed)`.
 */
export const appendAgentEventFramesBatch = async (
  entries: ReadonlyArray<AgentEventStreamBatchEntry>,
): Promise<ReadonlyArray<string | undefined>> => {
  if (entries.length === 0) {
    return [];
  }
  const client = connection.getClient();
  if (!client || !env.agentEventStreamEnabled) {
    return entries.map(() => undefined);
  }

  const accepted: { entry: AgentEventStreamBatchEntry; key: string; resultIndex: number }[] = [];
  const result: (string | undefined)[] = new Array<string | undefined>(entries.length).fill(
    undefined,
  );
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) {
      continue;
    }
    if (!isPrincipalInAllowlist(entry.principalId)) {
      continue;
    }
    accepted.push({ entry, key: streamKey(entry.principalId), resultIndex: i });
  }
  if (accepted.length === 0) {
    return result;
  }

  noteAgentEventStreamBatchAppend(accepted.length);

  /**
   * MULTI replies are positional and interleaved (XADD, [PEXPIRE]) per entry.
   * Step `cmdsPerEntry` slots at a time so we can recover the `XADD` reply
   * regardless of whether `PEXPIRE` was queued for this batch.
   */
  const cmdsPerEntry = env.agentEventStreamTtlMs > 0 ? 2 : 1;
  let appendedCount = 0;
  let failedCount = 0;

  const startedAtMs = performance.now();
  try {
    /**
     * Pipeline the fan-out in bounded chunks: a single `MULTI/EXEC` per chunk
     * keeps the client-side queue and the server `EXEC` reply array bounded
     * for very large fan-outs (thousands of recipients) instead of one giant
     * transaction. A chunk-level `EXEC` failure is isolated (other chunks still
     * flush) and counted once via `noteAgentEventStreamCommandError`.
     */
    for (let start = 0; start < accepted.length; start += XADD_PIPELINE_CHUNK_SIZE) {
      const chunk = accepted.slice(start, start + XADD_PIPELINE_CHUNK_SIZE);
      try {
        const replies = await withRedisSpan(
          {
            module: "agent_event_stream",
            op: "xadd_batch",
            keyPrefix: "plug_agent_stream",
          },
          async () => {
            const tx = client.multi();
            for (const { entry, key } of chunk) {
              tx.xAdd(
                key,
                "*",
                {
                  schemaVersion: String(AGENT_EVENT_STREAM_FRAME_SCHEMA_VERSION),
                  eventId: entry.frame.eventId,
                  eventName: entry.frame.eventName,
                  emittedAt: entry.frame.emittedAt,
                  payload: entry.frame.payload,
                },
                {
                  TRIM: {
                    strategy: "MAXLEN",
                    strategyModifier: "~",
                    threshold: env.agentEventStreamMaxLen,
                  },
                },
              );
              if (env.agentEventStreamTtlMs > 0) {
                tx.pExpire(key, env.agentEventStreamTtlMs);
              }
            }
            return tx.exec();
          },
        );

        if (Array.isArray(replies)) {
          for (let i = 0; i < chunk.length; i += 1) {
            const slot = chunk[i];
            if (slot === undefined) {
              continue;
            }
            const xaddReply = replies[i * cmdsPerEntry];
            if (typeof xaddReply === "string" && xaddReply !== "") {
              result[slot.resultIndex] = xaddReply;
              appendedCount += 1;
            } else {
              failedCount += 1;
            }
          }
        } else {
          // Defensive: `multi().exec()` always returns an array, but if it ever
          // doesn't (e.g. mocked client in tests), treat the chunk as failed.
          failedCount += chunk.length;
        }
      } catch (error: unknown) {
        // Isolated chunk EXEC failure: its entries stay `undefined`, counted as
        // a command error (not a per-entry partial failure) to mirror the
        // pre-chunking whole-batch semantics.
        noteAgentEventStreamCommandError();
        logger.warn("agent_event_stream_append_batch_failed", {
          batchSize: chunk.length,
          message: toSafeErrorMessage(error),
        });
      }
    }

    if (appendedCount > 0) {
      // Mirror the per-frame counter so existing dashboards keep working.
      for (let i = 0; i < appendedCount; i += 1) {
        noteAgentEventStreamAppend();
      }
    }
    if (failedCount > 0) {
      noteAgentEventStreamBatchPartialFailure(failedCount);
    }
    return result;
  } finally {
    observeAgentEventStreamLatency("append", performance.now() - startedAtMs);
  }
};

/**
 * Shape returned by `node-redis` `xRead` for one stream's batch. Kept as a
 * named type guard so the runtime cast at the call site stays narrow and
 * the structural expectations are documented in one place.
 */
interface XReadStreamBatch {
  readonly name: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly message: Record<string, string>;
  }>;
}

const isXReadStreamBatch = (value: unknown): value is XReadStreamBatch => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { name?: unknown; messages?: unknown };
  if (typeof candidate.name !== "string" || !Array.isArray(candidate.messages)) {
    return false;
  }
  return true;
};

const parseStreamMessage = (
  raw: { id: string; message: Record<string, string> } | undefined,
): AgentEventStreamBacklogEntry | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const { schemaVersion, eventId, eventName, emittedAt, payload } = raw.message;
  /**
   * Backward-compat: legacy entries written before Sprint 10 do not carry
   * `schemaVersion`. We accept them as version 1 (the only schema in use)
   * so existing streams drain cleanly. Any non-empty value that does NOT
   * parse to the current version is rejected — caller bumps `noteAgentEventStreamDropped()`
   * so a stale agent re-deploy after a future schema bump surfaces the
   * incompatibility through the metrics dashboard.
   */
  if (typeof schemaVersion === "string" && schemaVersion !== "") {
    const parsedVersion = Number.parseInt(schemaVersion, 10);
    if (
      !Number.isFinite(parsedVersion) ||
      parsedVersion !== AGENT_EVENT_STREAM_FRAME_SCHEMA_VERSION
    ) {
      return undefined;
    }
  }
  if (
    typeof eventId !== "string" ||
    typeof eventName !== "string" ||
    typeof emittedAt !== "string" ||
    typeof payload !== "string"
  ) {
    return undefined;
  }
  return {
    streamId: raw.id,
    eventId,
    eventName,
    emittedAt,
    payload,
  };
};

/**
 * Ensures the consumer group exists for `key`. Idempotent: `BUSYGROUP` is
 * the expected error when the group already exists and is swallowed.
 * MKSTREAM allows the create call to also bootstrap an empty stream when
 * no append has happened yet.
 */
const ensureConsumerGroup = async (client: InstrumentedRedisClient, key: string): Promise<void> => {
  try {
    await client.sendCommand([
      "XGROUP",
      "CREATE",
      key,
      env.agentEventStreamConsumerGroup,
      "$",
      "MKSTREAM",
    ]);
  } catch (error: unknown) {
    if (error instanceof Error && /BUSYGROUP/i.test(error.message ?? "")) {
      return;
    }
    throw error;
  }
};

const consumerName = (): string => `replica:${env.hubInstanceId}`;

/**
 * Reads frames appended to the per-recipient stream after `lastSeenStreamId`.
 * Pass `"$"` (the special node-redis sentinel meaning "end of stream") on the
 * first connect to skip historical entries; otherwise pass the last known
 * stream id received by the recipient (recovered from cursor persistence).
 *
 * When `AGENT_EVENT_STREAM_USE_CONSUMER_GROUPS=true`, this reads via
 * XREADGROUP so cross-replica coordination prevents duplicate delivery; the
 * `lastSeenStreamId` argument is ignored in that mode (`>` is always used).
 */
export const readAgentEventBacklog = async (
  principalId: string,
  lastSeenStreamId: string,
): Promise<readonly AgentEventStreamBacklogEntry[]> => {
  const client = connection.getClient();
  if (!client || !env.agentEventStreamEnabled) {
    return [];
  }
  const key = streamKey(principalId);
  if (env.agentEventStreamUseConsumerGroups) {
    return readAgentEventBacklogConsumerGroup(client, principalId, key);
  }
  const startedAtMs = performance.now();
  try {
    const result: unknown = await client.xRead([{ key, id: lastSeenStreamId }], {
      COUNT: env.agentEventStreamBacklogMaxEntries,
    });
    const entries: AgentEventStreamBacklogEntry[] = [];
    if (Array.isArray(result)) {
      for (const candidate of result) {
        if (!isXReadStreamBatch(candidate) || candidate.name !== key) {
          continue;
        }
        for (const message of candidate.messages) {
          const parsed = parseStreamMessage(message);
          if (parsed !== undefined) {
            entries.push(parsed);
          } else {
            noteAgentEventStreamDropped();
          }
        }
      }
    }
    noteAgentEventStreamBacklogRead(entries.length);
    return entries;
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_read_failed", {
      principalId,
      message: toSafeErrorMessage(error),
    });
    return [];
  } finally {
    observeAgentEventStreamLatency("read", performance.now() - startedAtMs);
  }
};

const readAgentEventBacklogConsumerGroup = async (
  client: InstrumentedRedisClient,
  principalId: string,
  key: string,
): Promise<readonly AgentEventStreamBacklogEntry[]> => {
  const startedAtMs = performance.now();
  try {
    await ensureConsumerGroup(client, key);
    const result: unknown = await client.sendCommand([
      "XREADGROUP",
      "GROUP",
      env.agentEventStreamConsumerGroup,
      consumerName(),
      "COUNT",
      String(env.agentEventStreamBacklogMaxEntries),
      "STREAMS",
      key,
      ">",
    ]);
    const entries: AgentEventStreamBacklogEntry[] = [];
    if (Array.isArray(result)) {
      for (const candidate of result) {
        if (!Array.isArray(candidate) || candidate.length < 2) {
          continue;
        }
        const [streamName, messages] = candidate as [unknown, unknown];
        if (typeof streamName !== "string" || streamName !== key || !Array.isArray(messages)) {
          continue;
        }
        for (const raw of messages) {
          if (!Array.isArray(raw) || raw.length < 2) {
            noteAgentEventStreamDropped();
            continue;
          }
          const [id, fields] = raw as [unknown, unknown];
          if (typeof id !== "string" || !Array.isArray(fields)) {
            noteAgentEventStreamDropped();
            continue;
          }
          // Redis returns flat field array `[k1, v1, k2, v2, ...]`.
          const message: Record<string, string> = {};
          for (let i = 0; i + 1 < fields.length; i += 2) {
            const k = fields[i];
            const v = fields[i + 1];
            if (typeof k === "string" && typeof v === "string") {
              message[k] = v;
            }
          }
          const parsed = parseStreamMessage({ id, message });
          if (parsed !== undefined) {
            entries.push(parsed);
          } else {
            noteAgentEventStreamDropped();
          }
        }
      }
    }
    noteAgentEventStreamBacklogRead(entries.length);
    return entries;
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_xreadgroup_failed", {
      principalId,
      message: toSafeErrorMessage(error),
    });
    return [];
  } finally {
    observeAgentEventStreamLatency("read", performance.now() - startedAtMs);
  }
};

/**
 * Acknowledges or removes frames after delivery so the stream stays bounded.
 *
 * - With consumer groups (`AGENT_EVENT_STREAM_USE_CONSUMER_GROUPS=true`):
 *   `XACK` removes the entry from the Pending Entries List. The stream
 *   itself is trimmed by `XADD MAXLEN ~`.
 * - Without consumer groups: `XDEL` removes the entry from the stream.
 *   Idempotent: missing ids are silently ignored.
 */
export const ackAgentEventFrames = async (
  principalId: string,
  streamIds: readonly string[],
): Promise<void> => {
  const client = connection.getClient();
  if (!client || !env.agentEventStreamEnabled || streamIds.length === 0) {
    return;
  }
  const key = streamKey(principalId);
  const startedAtMs = performance.now();
  try {
    if (env.agentEventStreamUseConsumerGroups) {
      await client.sendCommand([
        "XACK",
        key,
        env.agentEventStreamConsumerGroup,
        ...(streamIds as string[]),
      ]);
    } else {
      await client.xDel(key, streamIds as string[]);
    }
    noteAgentEventStreamAck();
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_ack_failed", {
      principalId,
      count: streamIds.length,
      message: toSafeErrorMessage(error),
    });
  } finally {
    observeAgentEventStreamLatency("ack", performance.now() - startedAtMs);
  }
};

export async function initAgentEventStream(): Promise<void> {
  const url = env.agentEventStreamRedisUrl.trim();
  if (url === "" || !env.agentEventStreamEnabled) {
    await closeAgentEventStream();
    noteAgentEventStreamSkippedEmptyUrl();
    logger.info("agent_event_stream_skipped", {
      reason:
        url === "" ? "AGENT_EVENT_STREAM_REDIS_URL empty" : "AGENT_EVENT_STREAM_ENABLED=false",
    });
    return;
  }

  if (connection.isConnectedTo(url)) {
    return;
  }

  await closeAgentEventStream();

  const result = await connection.connect({
    url,
    logName: "agent_event_stream",
    buildCallbacks: (isCurrent) => ({
      onConnected: () => {
        noteAgentEventStreamConnected();
        logger.info("agent_event_stream_connected");
      },
      onError: () => {
        if (!isCurrent()) {
          return;
        }
        noteAgentEventStreamFallback();
      },
      onEnd: () => {
        if (!isCurrent()) {
          return;
        }
        noteAgentEventStreamDisconnected();
      },
      onFallback: () => {
        noteAgentEventStreamFallback();
      },
    }),
  });

  if (result === undefined) {
    return;
  }
  await validateRedisClusterTopology({
    client: result.client,
    logName: "agent_event_stream",
    sampleKeys: [
      `plug_agent_stream:${redisKeyNamespace()}:probe-agent-1`,
      `plug_agent_stream_cursor:${redisKeyNamespace()}:probe-agent-1`,
    ],
  });
}

export async function closeAgentEventStream(): Promise<void> {
  const hadClient = connection.getClient() !== undefined;
  await connection.teardown();
  if (hadClient) {
    noteAgentEventStreamDisconnected();
  }
}
