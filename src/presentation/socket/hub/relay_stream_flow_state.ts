/**
 * Mutable relay stream backpressure state (credits, buffered chunks, deferred complete).
 * Relay handlers in `rpc_bridge.ts` own emission/audit; this module only holds the maps.
 */

export interface RelayStreamFlowEntry {
  credits: number;
  bufferedChunks: Record<string, unknown>[];
  pendingComplete?: Record<string, unknown>;
  forwardedRows: number;
}

const entriesByRequestId = new Map<string, RelayStreamFlowEntry>();
const drainTailByRequestId = new Map<string, Promise<void>>();
let globalTotalBufferedChunks = 0;

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

export const addRelayStreamFlowCredits = (requestId: string, delta: number): number => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  entry.credits = Math.max(0, entry.credits + delta);
  return entry.credits;
};

export const getRelayStreamBufferedChunks = (requestId: string): Record<string, unknown>[] => {
  return entriesByRequestId.get(requestId)?.bufferedChunks ?? [];
};

export const addRelayStreamBufferedChunk = (requestId: string, chunk: Record<string, unknown>): void => {
  const entry = ensureRelayStreamFlowEntry(requestId);
  entry.bufferedChunks.push(chunk);
  globalTotalBufferedChunks += 1;
};

export const getRelayStreamPendingComplete = (requestId: string): Record<string, unknown> | undefined => {
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
      map.set(requestId, entry.bufferedChunks);
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
};

export const clearRelayStreamFlowState = (requestId: string): void => {
  const entry = entriesByRequestId.get(requestId);
  if (entry && entry.bufferedChunks.length > 0) {
    globalTotalBufferedChunks = Math.max(0, globalTotalBufferedChunks - entry.bufferedChunks.length);
  }
  entriesByRequestId.delete(requestId);
  drainTailByRequestId.delete(requestId);
};

export const resetRelayStreamFlowState = (): void => {
  entriesByRequestId.clear();
  drainTailByRequestId.clear();
  globalTotalBufferedChunks = 0;
};

export interface DrainRelayStreamBufferContext {
  readonly requestId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly emitChunk: (frame: unknown) => void;
  readonly emitComplete: (frame: unknown) => void;
  readonly encodeFrame: (data: unknown) => Promise<unknown>;
  readonly recordAudit: (eventType: string, extras?: Record<string, unknown>) => void;
  readonly onComplete?: (streamId: string | null) => void;
}

const countChunkRows = (payload: Record<string, unknown>): number => {
  return Array.isArray(payload.rows) ? payload.rows.length : 0;
};

export const drainRelayStreamBuffer = async (
  ctx: DrainRelayStreamBufferContext,
): Promise<{ readonly chunksDrained: number; readonly completeEmitted: boolean }> => {
  const previousDrain = drainTailByRequestId.get(ctx.requestId)?.catch(() => undefined) ?? Promise.resolve();
  let chunksDrained = 0;
  let completeEmitted = false;
  const nextDrain = previousDrain.then(async () => {
    let credits = getRelayStreamFlowCredits(ctx.requestId);
    const bufferedChunks = getRelayStreamBufferedChunks(ctx.requestId);

    if (credits > 0 && bufferedChunks.length > 0) {
      while (credits > 0 && bufferedChunks.length > 0) {
        const chunk = bufferedChunks.shift();
        if (!chunk) {
          break;
        }

        globalTotalBufferedChunks = Math.max(0, globalTotalBufferedChunks - 1);
        addRelayStreamForwardedRows(ctx.requestId, countChunkRows(chunk));

        const frame = await ctx.encodeFrame(chunk);
        ctx.emitChunk(frame);
        chunksDrained += 1;

        const streamId = typeof chunk.stream_id === "string" ? chunk.stream_id : null;
        ctx.recordAudit("relay:rpc.chunk", streamId ? { streamId } : {});

        credits -= 1;
      }

      setRelayStreamFlowCredits(ctx.requestId, Math.max(0, credits));
    }

    const pendingComplete = getRelayStreamPendingComplete(ctx.requestId);
    if (bufferedChunks.length === 0 && pendingComplete) {
      const completeFrame = await ctx.encodeFrame(pendingComplete);
      ctx.emitComplete(completeFrame);
      completeEmitted = true;

      const streamId = typeof pendingComplete.stream_id === "string" ? pendingComplete.stream_id : null;
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
  return { chunksDrained, completeEmitted };
};
