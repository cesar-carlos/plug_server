/**
 * Drains the per-recipient durable backlog stream onto a freshly-connected
 * socket. Triggered after a successful `socket:event.subscribe` so we only
 * deliver frames the client is actually subscribed to.
 *
 * Delivery contract (at-least-once):
 *
 * 1. Read frames from `lastSeenStreamId` (cursor) up to
 *    `AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES`.
 * 2. Filter to frames whose `eventName` matches the subscription that just
 *    succeeded (other subscriptions trigger their own drains).
 * 3. Emit each frame serially with a `then(ack)` promise gated by
 *    `AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS`.
 * 4. After the ack, advance the cursor and `XDEL` the entry.
 *
 * On any failure we stop the drain and leave remaining frames for the next
 * reconnect — the agent is expected to dedupe by `eventId`.
 */

import type { Socket } from "socket.io";

import {
  ackAgentEventFrames,
  isAgentEventStreamActive,
  readAgentEventBacklog,
  type AgentEventStreamBacklogEntry,
} from "../../../infrastructure/redis/event_stream/agent_event_stream";
import {
  commitAgentEventCursor,
  getAgentEventCursor,
} from "../../../infrastructure/redis/event_stream/agent_event_stream_cursor";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";

interface DrainBacklogInput {
  readonly socket: Socket;
  readonly principalId: string;
  readonly eventName: string;
}

const emitFrameWithAck = (
  socket: Socket,
  eventName: string,
  payload: string,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    try {
      // Socket.IO ack signature: emit(event, ...args, callback). The agent SDK
      // is expected to invoke the callback after consuming the frame.
      socket.emit(eventName, payload, () => {
        clearTimeout(timer);
        resolve(true);
      });
    } catch (error: unknown) {
      clearTimeout(timer);
      logger.warn("agent_event_stream_drain_emit_failed", {
        eventName,
        message: error instanceof Error ? error.message : String(error),
      });
      resolve(false);
    }
  });

export const drainAgentEventBacklogForSubscription = async (
  input: DrainBacklogInput,
): Promise<void> => {
  if (!isAgentEventStreamActive() || !input.socket.connected) {
    return;
  }

  let lastSeenStreamId: string;
  try {
    lastSeenStreamId = await getAgentEventCursor(input.principalId);
  } catch (error: unknown) {
    logger.warn("agent_event_stream_drain_cursor_failed", {
      principalId: input.principalId,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let entries: readonly AgentEventStreamBacklogEntry[];
  try {
    entries = await readAgentEventBacklog(input.principalId, lastSeenStreamId);
  } catch (error: unknown) {
    logger.warn("agent_event_stream_drain_read_failed", {
      principalId: input.principalId,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (entries.length === 0) {
    return;
  }

  const matching = entries.filter((entry) => entry.eventName === input.eventName);
  if (matching.length === 0) {
    return;
  }

  const timeoutMs = env.agentEventStreamDrainAckTimeoutMs;
  const acked: string[] = [];

  for (const entry of matching) {
    if (!input.socket.connected) {
      break;
    }
    const ackOk = await emitFrameWithAck(input.socket, entry.eventName, entry.payload, timeoutMs);
    if (!ackOk) {
      // Leave the remaining frames for the next reconnect.
      break;
    }
    acked.push(entry.streamId);
    try {
      await commitAgentEventCursor(input.principalId, entry.streamId);
    } catch (error: unknown) {
      logger.warn("agent_event_stream_drain_cursor_commit_failed", {
        principalId: input.principalId,
        streamId: entry.streamId,
        message: error instanceof Error ? error.message : String(error),
      });
      // Cursor commit failure is non-fatal; we still XDEL the entry and the
      // agent's next reconnect will start from the last successful cursor.
    }
  }

  if (acked.length > 0) {
    try {
      await ackAgentEventFrames(input.principalId, acked);
    } catch (error: unknown) {
      logger.warn("agent_event_stream_drain_xdel_failed", {
        principalId: input.principalId,
        ackedCount: acked.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
