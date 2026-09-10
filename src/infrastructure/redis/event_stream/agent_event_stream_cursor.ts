/**
 * Persisted cursor for one recipient-event backlog stream.
 *
 * The stream itself stores a bounded ring of frames (`agent_event_stream.ts`).
 * The cursor records the last `streamId` an agent acknowledged, so on
 * reconnect we can resume reading from `lastSeenStreamId` instead of replaying
 * everything (or skipping with `"$"` and losing the backlog).
 *
 * Cursor key (Redis Cluster hash-tagged):
 *
 *   plug_agent_stream_cursor_v2:{plug}:<sanitized-principal-id>:<event-hash>  ->  "<streamId>"
 *
 * TTL mirrors `AGENT_EVENT_STREAM_TTL_MS` so an agent that is offline longer
 * than the stream retention also has its cursor garbage-collected.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  noteAgentEventStreamCommandError,
  observeAgentEventStreamLatency,
} from "../../../application/services/agent_event_stream_metrics.service";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";
import { getAgentEventStreamRedisClient } from "./agent_event_stream";
import { redisKeyNamespace, sanitizeRedisKeySegment } from "../keyspace/redis_key_namespace";

const sanitizePrincipalId = (principalId: string): string => sanitizeRedisKeySegment(principalId);

const eventNameHash = (eventName: string): string =>
  createHash("sha256").update(eventName).digest("hex").slice(0, 32);

const cursorKey = (principalId: string, eventName: string): string =>
  `plug_agent_stream_cursor_v2:${redisKeyNamespace()}:${sanitizePrincipalId(principalId)}:${eventNameHash(eventName)}`;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Returns the last cursor stored for one `(principalId, eventName)` stream or `"$"` when there is
 * none. `"$"` is the `node-redis` sentinel for "tail of stream"; using it
 * on the first-ever drain skips historical entries (correct: we should not
 * deliver frames that pre-date the recipient's first stream-aware connection).
 */
export const getAgentEventCursor = async (
  principalId: string,
  eventName: string,
): Promise<string> => {
  const client = getAgentEventStreamRedisClient();
  if (client === undefined) {
    return "$";
  }
  const startedAtMs = performance.now();
  try {
    const value = await client.get(cursorKey(principalId, eventName));
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return "$";
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_cursor_get_failed", {
      principalId,
      eventName,
      message: toSafeErrorMessage(error),
    });
    return "$";
  } finally {
    observeAgentEventStreamLatency("read", performance.now() - startedAtMs);
  }
};

/**
 * Persists `streamId` as the highest acknowledged entry for one event stream.
 * Best effort: failures degrade the next reconnect into "re-deliver since
 * last committed cursor", which is acceptable because the recipient is
 * expected to dedupe on `eventId`.
 */
export const commitAgentEventCursor = async (
  principalId: string,
  eventName: string,
  streamId: string,
): Promise<void> => {
  const client = getAgentEventStreamRedisClient();
  if (client === undefined) {
    return;
  }
  const startedAtMs = performance.now();
  try {
    if (env.agentEventStreamTtlMs > 0) {
      await client.set(cursorKey(principalId, eventName), streamId, {
        PX: env.agentEventStreamTtlMs,
      });
    } else {
      await client.set(cursorKey(principalId, eventName), streamId);
    }
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_cursor_commit_failed", {
      principalId,
      eventName,
      streamId,
      message: toSafeErrorMessage(error),
    });
  } finally {
    observeAgentEventStreamLatency("ack", performance.now() - startedAtMs);
  }
};

/**
 * Removes the cursor for one `(principalId, eventName)` stream. Use when the recipient is
 * permanently deactivated or its stream is intentionally reset.
 */
export const purgeAgentEventCursor = async (
  principalId: string,
  eventName: string,
): Promise<void> => {
  const client = getAgentEventStreamRedisClient();
  if (client === undefined) {
    return;
  }
  try {
    await client.del(cursorKey(principalId, eventName));
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_cursor_purge_failed", {
      principalId,
      eventName,
      message: toSafeErrorMessage(error),
    });
  }
};
