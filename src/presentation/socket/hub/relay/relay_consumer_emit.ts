import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";

let relayConsumerEmit: EmitToConsumerFn | null = null;

export const wireRelayConsumerEmit = (emitToConsumer: EmitToConsumerFn): void => {
  relayConsumerEmit = emitToConsumer;
};

export const resetRelayConsumerEmitForTests = (): void => {
  relayConsumerEmit = null;
};

export const getRelayConsumerEmit = (): EmitToConsumerFn | null => relayConsumerEmit;

/**
 * Emits to the consumer when the bridge is wired; returns `true` when the socket
 * was found and `emit` was invoked.
 */
export const emitToRelayConsumer = (
  consumerSocketId: string,
  eventName: string,
  payload: unknown,
): boolean => {
  const emit = relayConsumerEmit;
  if (!emit) {
    return false;
  }
  return emit(consumerSocketId, eventName, payload);
};
