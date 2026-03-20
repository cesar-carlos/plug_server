/**
 * Mutable relay stream backpressure state (credits, buffered chunks, deferred complete).
 * Relay handlers in `rpc_bridge.ts` own emission/audit; this module only holds the maps.
 */
export const relayStreamFlowState = {
  creditsByRequestId: new Map<string, number>(),
  bufferedChunksByRequestId: new Map<string, Record<string, unknown>[]>(),
  pendingCompleteByRequestId: new Map<string, Record<string, unknown>>(),
  totalBufferedChunks: 0,
};

export const clearRelayStreamFlowState = (requestId: string): void => {
  relayStreamFlowState.creditsByRequestId.delete(requestId);
  const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(requestId);
  if (buffered && buffered.length > 0) {
    relayStreamFlowState.totalBufferedChunks = Math.max(
      0,
      relayStreamFlowState.totalBufferedChunks - buffered.length,
    );
  }
  relayStreamFlowState.bufferedChunksByRequestId.delete(requestId);
  relayStreamFlowState.pendingCompleteByRequestId.delete(requestId);
};

export const resetRelayStreamFlowState = (): void => {
  relayStreamFlowState.creditsByRequestId.clear();
  relayStreamFlowState.bufferedChunksByRequestId.clear();
  relayStreamFlowState.pendingCompleteByRequestId.clear();
  relayStreamFlowState.totalBufferedChunks = 0;
};
