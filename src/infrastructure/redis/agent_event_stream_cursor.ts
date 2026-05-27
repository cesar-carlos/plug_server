/**
 * Persisted cursor for the per-agent event backlog stream.
 *
 * The stream itself stores a bounded ring of frames (`agent_event_stream.ts`).
 * The cursor records the last `streamId` an agent acknowledged, so on
 * reconnect we can resume reading from `lastSeenStreamId` instead of replaying
 * everything (or skipping with `"$"` and losing the backlog).
 *
 * Cursor key (Redis Cluster hash-tagged):
 *
 *   plug_agent_stream_cursor:{plug}:<sanitized-agent-id>  ->  "<streamId>"
 *
 * TTL mirrors `AGENT_EVENT_STREAM_TTL_MS` so an agent that is offline longer
 * than the stream retention also has its cursor garbage-collected.
 */

import { performance } from "node:perf_hooks";

import {
  noteAgentEventStreamCommandError,
  observeAgentEventStreamLatency,
} from "../../application/services/agent_event_stream_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";
import { getAgentEventStreamRedisClient } from "./agent_event_stream";
import { redisKeyNamespace } from "./redis_key_namespace";

const sanitizePrincipalId = (principalId: string): string =>
  principalId.replace(/[^A-Za-z0-9:_-]/g, "_");

const cursorKey = (principalId: string): string =>
  `plug_agent_stream_cursor:${redisKeyNamespace()}:${sanitizePrincipalId(principalId)}`;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Returns the last cursor stored for `principalId` or `"$"` when there is
 * none. `"$"` is the `node-redis` sentinel for "tail of stream"; using it
 * on the first-ever drain skips historical entries (correct: we should not
 * deliver frames that pre-date the recipient's first stream-aware connection).
 */
export const getAgentEventCursor = async (principalId: string): Promise<string> => {
  const client = getAgentEventStreamRedisClient();
  if (client === undefined) {
    return "$";
  }
  const startedAtMs = performance.now();
  try {
    const value = await client.get(cursorKey(principalId));
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return "$";
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_cursor_get_failed", {
      principalId,
      message: toSafeErrorMessage(error),
    });
    return "$";
  } finally {
    observeAgentEventStreamLatency("read", performance.now() - startedAtMs);
  }
};

/**
 * Persists `streamId` as the highest acknowledged entry for `principalId`.
 * Best effort: failures degrade the next reconnect into "re-deliver since
 * last committed cursor", which is acceptable because the recipient is
 * expected to dedupe on `eventId`.
 */
export const commitAgentEventCursor = async (
  principalId: string,
  streamId: string,
): Promise<void> => {
  const client = getAgentEventStreamRedisClient();
  if (client === undefined) {
    return;
  }
  const startedAtMs = performance.now();
  try {
    if (env.agentEventStreamTtlMs > 0) {
      await client.set(cursorKey(principalId), streamId, { PX: env.agentEventStreamTtlMs });
    } else {
      await client.set(cursorKey(principalId), streamId);
    }
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_cursor_commit_failed", {
      principalId,
      streamId,
      message: toSafeErrorMessage(error),
    });
  } finally {
    observeAgentEventStreamLatency("ack", performance.now() - startedAtMs);
  }
};

/**
 * Removes the cursor for `principalId`. Use when the recipient is
 * permanently deactivated or its stream is intentionally reset.
 */
export const purgeAgentEventCursor = async (principalId: string): Promise<void> => {
  const client = getAgentEventStreamRedisClient();
  if (client === undefined) {
    return;
  }
  try {
    await client.del(cursorKey(principalId));
  } catch (error: unknown) {
    noteAgentEventStreamCommandError();
    logger.warn("agent_event_stream_cursor_purge_failed", {
      principalId,
      message: toSafeErrorMessage(error),
    });
  }
};
