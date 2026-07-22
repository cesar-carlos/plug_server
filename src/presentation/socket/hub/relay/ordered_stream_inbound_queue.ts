import { performance } from "node:perf_hooks";

import { logger } from "../../../../shared/utils/logger";

/** Warn when a single ordered inbound work unit blocks the socket chain this long. */
const ORDERED_INBOUND_SLOW_WORK_MS = 5_000;

let orderedInboundSlowWorkTotal = 0;

export const getOrderedStreamInboundSlowWorkTotal = (): number => orderedInboundSlowWorkTotal;

export const resetOrderedStreamInboundSlowWorkTotalForTests = (): void => {
  orderedInboundSlowWorkTotal = 0;
};

export interface OrderedStreamInboundQueue {
  /**
   * Runs `work` after any previously enqueued work for the same `socketId`,
   * preserving per-socket ordering of streamed inbound frames (`rpc:chunk`,
   * `rpc:complete`). Failures are isolated: a rejected `work` is logged and does
   * not break the chain for subsequent frames.
   *
   * Work already past its generation check may still finish; callers should
   * re-validate routes before side effects after awaits.
   */
  enqueue(socketId: string, work: () => Promise<void>): void;
  /**
   * Invalidates pending and not-yet-started work for `socketId` (disconnect).
   * In-flight `work` that already started is not aborted; bumping the generation
   * skips queued tails that have not begun.
   */
  cleanup(socketId: string): void;
  /** Clear all per-socket tails and generations (test/bootstrap helper). */
  reset(): void;
}

/**
 * Serializes per-socket inbound stream processing via a promise tail per
 * `socketId`. Extracted from the `createRpcBridgeAgentInboundHandlers` closure
 * so the ordering guarantee is a small, independently testable unit.
 */
export const createOrderedStreamInboundQueue = (options?: {
  readonly slowWorkWarnMs?: number;
}): OrderedStreamInboundQueue => {
  const slowWorkWarnMs = options?.slowWorkWarnMs ?? ORDERED_INBOUND_SLOW_WORK_MS;
  const tailBySocketId = new Map<string, Promise<void>>();
  const generationBySocketId = new Map<string, number>();

  const currentGeneration = (socketId: string): number => generationBySocketId.get(socketId) ?? 0;

  const pruneGenerationIfIdle = (socketId: string, expectedGeneration: number): void => {
    if (tailBySocketId.has(socketId)) {
      return;
    }
    if (generationBySocketId.get(socketId) === expectedGeneration) {
      generationBySocketId.delete(socketId);
    }
  };

  const enqueue = (socketId: string, work: () => Promise<void>): void => {
    const generation = currentGeneration(socketId);
    const prev = tailBySocketId.get(socketId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (currentGeneration(socketId) !== generation) {
          return;
        }
        const startedAt = performance.now();
        await work();
        const elapsedMs = performance.now() - startedAt;
        if (elapsedMs >= slowWorkWarnMs) {
          orderedInboundSlowWorkTotal += 1;
          logger.warn("rpc_stream_inbound_work_slow", {
            socketId,
            elapsedMs: Math.round(elapsedMs),
            thresholdMs: slowWorkWarnMs,
          });
        }
      })
      .catch((error: unknown) => {
        logger.warn("rpc_stream_inbound_processing_failed", {
          socketId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    tailBySocketId.set(socketId, next);
    void next.finally(() => {
      if (tailBySocketId.get(socketId) === next) {
        tailBySocketId.delete(socketId);
      }
      pruneGenerationIfIdle(socketId, generation);
    });
  };

  return {
    enqueue,
    cleanup: (socketId: string): void => {
      const nextGeneration = currentGeneration(socketId) + 1;
      generationBySocketId.set(socketId, nextGeneration);
      const abandoned = tailBySocketId.get(socketId);
      tailBySocketId.delete(socketId);
      if (!abandoned) {
        // Idle disconnect: no in-flight chain to invalidate beyond the bump.
        generationBySocketId.delete(socketId);
        return;
      }
      // Keep the bumped generation until the abandoned chain finishes so
      // not-yet-started work still sees a mismatch; then prune the map key.
      void abandoned.finally(() => {
        pruneGenerationIfIdle(socketId, nextGeneration);
      });
    },
    reset: (): void => {
      tailBySocketId.clear();
      generationBySocketId.clear();
    },
  };
};
