import type { Socket } from "socket.io";

import { env } from "../../../../shared/config/env";
import { relayMetrics } from "./bridge_relay_health_metrics";

type ConsumerTransportState = {
  readonly writable?: boolean;
  readonly socket?: {
    readonly bufferedAmount?: number;
    readonly writableLength?: number;
  };
};

const readConsumerTransportBufferedBytes = (socket: Socket): number => {
  const transport = socket.conn?.transport as ConsumerTransportState | undefined;
  const rawSocket = transport?.socket;
  if (!rawSocket) {
    return 0;
  }
  if (typeof rawSocket.bufferedAmount === "number" && Number.isFinite(rawSocket.bufferedAmount)) {
    return Math.max(0, rawSocket.bufferedAmount);
  }
  if (typeof rawSocket.writableLength === "number" && Number.isFinite(rawSocket.writableLength)) {
    return Math.max(0, rawSocket.writableLength);
  }
  return 0;
};

/**
 * Transport backpressure applies only to high-volume relay stream chunks, not
 * to unary control events (`accepted`, `request_ack`, `response`, `complete`).
 */
export const isConsumerRelayTransportWritable = (socket: Socket): boolean => {
  const maxBufferedBytes = env.socketRelayConsumerTransportMaxBufferedBytes;
  if (maxBufferedBytes <= 0) {
    return true;
  }

  const transport = socket.conn?.transport as ConsumerTransportState | undefined;
  if (transport?.writable === false) {
    return false;
  }

  return readConsumerTransportBufferedBytes(socket) < maxBufferedBytes;
};

export const noteRelayStreamChunkEmitBackpressurePaused = (): void => {
  relayMetrics.relayEmitBackpressurePaused += 1;
};
