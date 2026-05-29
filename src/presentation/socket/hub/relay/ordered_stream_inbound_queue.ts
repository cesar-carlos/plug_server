import { logger } from "../../../../shared/utils/logger";

export interface OrderedStreamInboundQueue {
  /**
   * Runs `work` after any previously enqueued work for the same `socketId`,
   * preserving per-socket ordering of streamed inbound frames (`rpc:chunk`,
   * `rpc:complete`). Failures are isolated: a rejected `work` is logged and does
   * not break the chain for subsequent frames.
   */
  enqueue(socketId: string, work: () => Promise<void>): void;
  /** Drop the pending tail for a socket (called on disconnect cleanup). */
  cleanup(socketId: string): void;
  /** Clear all per-socket tails (test/bootstrap helper). */
  reset(): void;
}

/**
 * Serializes per-socket inbound stream processing via a promise tail per
 * `socketId`. Extracted from the `createRpcBridgeAgentInboundHandlers` closure
 * so the ordering guarantee is a small, independently testable unit.
 */
export const createOrderedStreamInboundQueue = (): OrderedStreamInboundQueue => {
  const tailBySocketId = new Map<string, Promise<void>>();

  const enqueue = (socketId: string, work: () => Promise<void>): void => {
    const prev = tailBySocketId.get(socketId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(work)
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
    });
  };

  return {
    enqueue,
    cleanup: (socketId: string): void => {
      tailBySocketId.delete(socketId);
    },
    reset: (): void => {
      tailBySocketId.clear();
    },
  };
};
