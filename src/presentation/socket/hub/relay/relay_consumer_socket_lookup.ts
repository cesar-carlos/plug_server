import type { Socket } from "socket.io";

let consumerBridgeSocketLookup: ((socketId: string) => Socket | null) | null = null;

export const wireConsumerBridgeSocketLookup = (
  lookup: (socketId: string) => Socket | null,
): void => {
  consumerBridgeSocketLookup = lookup;
};

export const resetConsumerBridgeSocketLookupForTests = (): void => {
  consumerBridgeSocketLookup = null;
};

export const findConsumerBridgeSocketForRelay = (socketId: string): Socket | null =>
  consumerBridgeSocketLookup?.(socketId) ?? null;
