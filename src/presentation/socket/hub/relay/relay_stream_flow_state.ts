/**
 * Mutable relay stream backpressure state (credits, buffered chunks, deferred complete).
 * Relay handlers in `rpc_bridge.ts` own emission/audit; this module only holds the maps.
 */

import { env } from "../../../../shared/config/env";

/**
 * Original agent frame bytes captured for the byte-forward fast path: when a
 * relay chunk is forwarded **unchanged**, the drain re-emits these decoded
 * UTF-8 bytes (preserving the inbound `cmp` compression decision) instead of
 * re-running `JSON.stringify` + gzip on the parsed record. `undefined` for
 * chunks that have no forwardable source (e.g. REST-materialized chunks built
 * server-side), which fall back to the encode-from-record path.
 */
export interface RelayChunkRawForward {
  readonly bytes: Buffer;
  readonly cmp: "none" | "gzip";
}

export interface RelayStreamFlowEntry {
  credits: number;
  bufferedChunks: Record<string, unknown>[];
  bufferedChunkBytes: number[];
  bufferedChunkRawForward: (RelayChunkRawForward | undefined)[];
  bufferedChunkHead: number;
  bufferedBytes: number;
  pendingComplete?: Record<string, unknown>;
  forwardedRows: number;
}

const entriesByRequestId = new Map<string, RelayStreamFlowEntry>();
const drainTailByRequestId = new Map<string, Promise<void>>();
/** Deferred drain retries while the consumer transport is under backpressure. */
const backpressureRetryTimerByRequestId = new Map<string, NodeJS.Timeout>();
let globalTotalBufferedChunks = 0;
let globalTotalBufferedBytes = 0;

export const clearRelayStreamBackpressureRetryTimer = (requestId: string): void => {
  const timer = backpressureRetryTimerByRequestId.get(requestId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  backpressureRetryTimerByRequestId.delete(requestId);
};

export const setRelayStreamBackpressureRetryTimer = (
  requestId: string,
  timer: NodeJS.Timeout,
): void => {
  clearRelayStreamBackpressureRetryTimer(requestId);
  backpressureRetryTimerByRequestId.set(requestId, timer);
};

export const hasRelayStreamBackpressureRetryTimer = (requestId: string): boolean =>
  backpressureRetryTimerByRequestId.has(requestId);

export const clearAllRelayStreamBackpressureRetryTimers = (): void => {
  for (const timer of backpressureRetryTimerByRequestId.values()) {
    clearTimeout(timer);
  }
  backpressureRetryTimerByRequestId.clear();
};

export const getRelayStreamFlowEntry = (requestId: string): RelayStreamFlowEntry | undefined => {
  return entriesByRequestId.get(requestId);
};

export const ensureRelayStreamFlowEntry = (requestId: string): RelayStreamFlowEntry => {
  const existing = entriesByRequestId.get(requestId);
  if (existing) {
    return existing;
  }
  const created: RelayStreamFlowEntry = {
    credits: 0,
    bufferedChunks: [],
    bufferedChunkBytes: [],
    bufferedChunkRawForward: [],
    bufferedChunkHead: 0,
    bufferedBytes: 0,
    forwardedRows: 0,
  };
  entriesByRequestId.set(requestId, created);
  return created;
};

export const setRelayStreamFlowCredits = (requestId: string, credits: number): void => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  entry.credits = Math.max(0, credits);
};

export const getRelayStreamFlowCredits = (requestId: string): number => {
  return entriesByRequestId.get(requestId)?.credits ?? 0;
};

const maxFlowCreditsPerRequest = (): number =>
  Math.max(1, Math.floor(env.socketRestStreamPullMaxWindowSize));

export const addRelayStreamFlowCredits = (requestId: string, delta: number): number => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  const cappedDelta = Math.max(0, delta);
  entry.credits = Math.min(maxFlowCreditsPerRequest(), Math.max(0, entry.credits + cappedDelta));
  return entry.credits;
};

export const getRelayStreamBufferedChunks = (requestId: string): Record<string, unknown>[] => {
  const entry = entriesByRequestId.get(requestId);
  if (!entry) {
    return [];
  }
  return entry.bufferedChunkHead === 0
    ? entry.bufferedChunks
    : entry.bufferedChunks.slice(entry.bufferedChunkHead);
};

export const getRelayStreamBufferedChunkCount = (requestId: string): number => {
  const entry = entriesByRequestId.get(requestId);
  if (!entry) {
    return 0;
  }
  return Math.max(0, entry.bufferedChunks.length - entry.bufferedChunkHead);
};

export const getRelayStreamBufferedBytes = (requestId: string): number => {
  return entriesByRequestId.get(requestId)?.bufferedBytes ?? 0;
};

const normalizeBufferedByteLength = (byteLength: number): number => {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return 0;
  }
  return Math.ceil(byteLength);
};

export const addRelayStreamBufferedChunk = (
  requestId: string,
  chunk: Record<string, unknown>,
  byteLength = 0,
  rawForward?: RelayChunkRawForward,
): void => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  const normalizedByteLength = normalizeBufferedByteLength(byteLength);
  entry.bufferedChunks.push(chunk);
  entry.bufferedChunkBytes.push(normalizedByteLength);
  entry.bufferedChunkRawForward.push(rawForward);
  entry.bufferedBytes += normalizedByteLength;
  globalTotalBufferedChunks += 1;
  globalTotalBufferedBytes += normalizedByteLength;
};

export const popRelayStreamBufferedChunk = (
  requestId: string,
): Record<string, unknown> | undefined => {
  const entry = entriesByRequestId.get(requestId);
  if (!entry || entry.bufferedChunkHead >= entry.bufferedChunks.length) {
    return undefined;
  }

  const chunk = entry.bufferedChunks[entry.bufferedChunkHead];
  const byteLength = entry.bufferedChunkBytes[entry.bufferedChunkHead] ?? 0;
  entry.bufferedChunkHead += 1;
  entry.bufferedBytes = Math.max(0, entry.bufferedBytes - byteLength);
  globalTotalBufferedChunks = Math.max(0, globalTotalBufferedChunks - 1);
  globalTotalBufferedBytes = Math.max(0, globalTotalBufferedBytes - byteLength);

  if (entry.bufferedChunkHead >= entry.bufferedChunks.length) {
    entry.bufferedChunks = [];
    entry.bufferedChunkBytes = [];
    entry.bufferedChunkRawForward = [];
    entry.bufferedChunkHead = 0;
  } else if (
    entry.bufferedChunkHead >= 64 &&
    entry.bufferedChunkHead * 2 >= entry.bufferedChunks.length
  ) {
    entry.bufferedChunks = entry.bufferedChunks.slice(entry.bufferedChunkHead);
    entry.bufferedChunkBytes = entry.bufferedChunkBytes.slice(entry.bufferedChunkHead);
    entry.bufferedChunkRawForward = entry.bufferedChunkRawForward.slice(entry.bufferedChunkHead);
    entry.bufferedChunkHead = 0;
  }

  return chunk;
};

const peekRelayStreamBufferedChunk = (requestId: string): Record<string, unknown> | undefined => {
  const entry = entriesByRequestId.get(requestId);
  if (!entry || entry.bufferedChunkHead >= entry.bufferedChunks.length) {
    return undefined;
  }
  return entry.bufferedChunks[entry.bufferedChunkHead];
};

const peekRelayStreamBufferedChunkRawForward = (
  requestId: string,
): RelayChunkRawForward | undefined => {
  const entry = entriesByRequestId.get(requestId);
  if (!entry || entry.bufferedChunkHead >= entry.bufferedChunks.length) {
    return undefined;
  }
  return entry.bufferedChunkRawForward[entry.bufferedChunkHead];
};

export const getRelayStreamPendingComplete = (
  requestId: string,
): Record<string, unknown> | undefined => {
  return entriesByRequestId.get(requestId)?.pendingComplete;
};

export const setRelayStreamPendingComplete = (
  requestId: string,
  complete: Record<string, unknown>,
): void => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  entry.pendingComplete = complete;
};

export const clearRelayStreamPendingComplete = (requestId: string): void => {
  const entry = entriesByRequestId.get(requestId);
  if (entry && entry.pendingComplete) {
    delete entry.pendingComplete;
  }
};

export const getRelayStreamForwardedRows = (requestId: string): number => {
  return entriesByRequestId.get(requestId)?.forwardedRows ?? 0;
};

export const addRelayStreamForwardedRows = (requestId: string, delta: number): number => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  entry.forwardedRows += delta;
  return entry.forwardedRows;
};

export const getRelayStreamTotalBufferedChunks = (): number => {
  return globalTotalBufferedChunks;
};

export const getRelayStreamTotalBufferedBytes = (): number => {
  return globalTotalBufferedBytes;
};

export const relayStreamFlowState = {
  get creditsByRequestId(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [requestId, entry] of entriesByRequestId.entries()) {
      map.set(requestId, entry.credits);
    }
    return map;
  },
  get bufferedChunksByRequestId(): Map<string, Record<string, unknown>[]> {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const [requestId, entry] of entriesByRequestId.entries()) {
      map.set(
        requestId,
        entry.bufferedChunkHead === 0
          ? entry.bufferedChunks
          : entry.bufferedChunks.slice(entry.bufferedChunkHead),
      );
    }
    return map;
  },
  get pendingCompleteByRequestId(): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    for (const [requestId, entry] of entriesByRequestId.entries()) {
      if (entry.pendingComplete) {
        map.set(requestId, entry.pendingComplete);
      }
    }
    return map;
  },
  get forwardedRowsByRequestId(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [requestId, entry] of entriesByRequestId.entries()) {
      map.set(requestId, entry.forwardedRows);
    }
    return map;
  },
  get totalBufferedChunks(): number {
    return globalTotalBufferedChunks;
  },
  set totalBufferedChunks(value: number) {
    globalTotalBufferedChunks = value;
  },
  get totalBufferedBytes(): number {
    return globalTotalBufferedBytes;
  },
  set totalBufferedBytes(value: number) {
    globalTotalBufferedBytes = value;
  },
};

export const clearRelayStreamFlowState = (requestId: string): void => {
  const entry = entriesByRequestId.get(requestId);
  if (entry && entry.bufferedChunks.length > entry.bufferedChunkHead) {
    globalTotalBufferedChunks = Math.max(
      0,
      globalTotalBufferedChunks - (entry.bufferedChunks.length - entry.bufferedChunkHead),
    );
    globalTotalBufferedBytes = Math.max(0, globalTotalBufferedBytes - entry.bufferedBytes);
  }
  entriesByRequestId.delete(requestId);
  drainTailByRequestId.delete(requestId);
  clearRelayStreamBackpressureRetryTimer(requestId);
};

export const resetRelayStreamFlowState = (): void => {
  entriesByRequestId.clear();
  drainTailByRequestId.clear();
  globalTotalBufferedChunks = 0;
  globalTotalBufferedBytes = 0;
  clearAllRelayStreamBackpressureRetryTimers();
};

export interface DrainRelayStreamBufferContext {
  readonly requestId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly conversationId: string;
  readonly agentId: string;
  /**
   * Optional pre-check before encode+emit. When `false`, the drain pauses for
   * transport backpressure without encoding the head chunk again.
   */
  readonly canEmitChunk?: () => boolean;
  /** Returns `false` when the consumer transport is saturated (drain pauses). */
  readonly emitChunk: (frame: unknown) => boolean;
  readonly emitComplete: (frame: unknown) => boolean;
  readonly encodeFrame: (data: unknown) => Promise<unknown>;
  /**
   * Fast-path encoder that forwards the agent's original frame bytes unchanged
   * (skips `JSON.stringify` + a re-gzip of the parsed record). Provided only by
   * the relay path; when absent (or when a chunk has no captured bytes) the
   * drain falls back to {@link encodeFrame}.
   */
  readonly encodeFrameFromBytes?: (rawForward: RelayChunkRawForward) => Promise<unknown>;
  readonly recordAudit: (eventType: string, extras?: Record<string, unknown>) => void;
  readonly isActive?: () => boolean;
  readonly onComplete?: (streamId: string | null) => void;
  /** Invoked when `emitComplete` fails because the consumer socket is gone. */
  readonly onConsumerGone?: (requestId: string) => void;
}

const countChunkRows = (payload: Record<string, unknown>): number => {
  return Array.isArray(payload.rows) ? payload.rows.length : 0;
};

export const countRelayStreamBufferedRows = (requestId: string): number => {
  let total = 0;
  for (const chunk of getRelayStreamBufferedChunks(requestId)) {
    total += countChunkRows(chunk);
  }
  return total;
};

export const countRelayStreamAbortDropped = (
  requestId: string,
  rejectingPayload?: Record<string, unknown>,
): { readonly droppedChunks: number; readonly droppedRows: number } => {
  const bufferedChunks = getRelayStreamBufferedChunkCount(requestId);
  const bufferedRows = countRelayStreamBufferedRows(requestId);
  const rejectingRows = rejectingPayload ? countChunkRows(rejectingPayload) : 0;
  return {
    droppedChunks: bufferedChunks + (rejectingPayload ? 1 : 0),
    droppedRows: bufferedRows + rejectingRows,
  };
};

const isDrainContextActive = (ctx: DrainRelayStreamBufferContext): boolean => {
  return ctx.isActive?.() ?? true;
};

export const drainRelayStreamBuffer = async (
  ctx: DrainRelayStreamBufferContext,
): Promise<{
  readonly chunksDrained: number;
  readonly completeEmitted: boolean;
  readonly pausedForBackpressure: boolean;
}> => {
  const previousDrain =
    drainTailByRequestId.get(ctx.requestId)?.catch(() => undefined) ?? Promise.resolve();
  let chunksDrained = 0;
  let completeEmitted = false;
  let pausedForBackpressure = false;
  const nextDrain = previousDrain.then(async () => {
    if (!isDrainContextActive(ctx)) {
      return;
    }

    let credits = getRelayStreamFlowCredits(ctx.requestId);

    if (credits > 0 && getRelayStreamBufferedChunkCount(ctx.requestId) > 0) {
      while (credits > 0 && getRelayStreamBufferedChunkCount(ctx.requestId) > 0) {
        if (!isDrainContextActive(ctx)) {
          return;
        }
        if (ctx.canEmitChunk && !ctx.canEmitChunk()) {
          pausedForBackpressure = true;
          break;
        }
        const chunk = peekRelayStreamBufferedChunk(ctx.requestId);
        if (!chunk) {
          break;
        }

        const rawForward = peekRelayStreamBufferedChunkRawForward(ctx.requestId);
        const frame =
          rawForward !== undefined && ctx.encodeFrameFromBytes !== undefined
            ? await ctx.encodeFrameFromBytes(rawForward)
            : await ctx.encodeFrame(chunk);
        if (!isDrainContextActive(ctx)) {
          return;
        }
        if (!ctx.emitChunk(frame)) {
          pausedForBackpressure = true;
          break;
        }
        popRelayStreamBufferedChunk(ctx.requestId);
        addRelayStreamForwardedRows(ctx.requestId, countChunkRows(chunk));
        chunksDrained += 1;

        const streamId = typeof chunk.stream_id === "string" ? chunk.stream_id : null;
        ctx.recordAudit("relay:rpc.chunk", streamId ? { streamId } : {});

        credits -= 1;
      }

      setRelayStreamFlowCredits(ctx.requestId, Math.max(0, credits));
    }

    if (pausedForBackpressure) {
      return;
    }

    const pendingComplete = getRelayStreamPendingComplete(ctx.requestId);
    if (getRelayStreamBufferedChunkCount(ctx.requestId) === 0 && pendingComplete) {
      const completeFrame = await ctx.encodeFrame(pendingComplete);
      if (!isDrainContextActive(ctx)) {
        return;
      }
      if (!ctx.emitComplete(completeFrame)) {
        ctx.onConsumerGone?.(ctx.requestId);
        return;
      }
      completeEmitted = true;

      const streamId =
        typeof pendingComplete.stream_id === "string" ? pendingComplete.stream_id : null;
      ctx.recordAudit("relay:rpc.complete", streamId ? { streamId } : {});

      clearRelayStreamPendingComplete(ctx.requestId);
      ctx.onComplete?.(streamId);
    }
  });

  drainTailByRequestId.set(ctx.requestId, nextDrain);
  await nextDrain.finally(() => {
    if (drainTailByRequestId.get(ctx.requestId) === nextDrain) {
      drainTailByRequestId.delete(ctx.requestId);
    }
  });
  return { chunksDrained, completeEmitted, pausedForBackpressure };
};
