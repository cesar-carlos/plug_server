import type { Socket } from "socket.io";

import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { encodePayloadFrame } from "../../../shared/utils/payload_frame";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

export const CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER = "2026-09-30";

export type ConnectionReadyPayload = {
  readonly id: string;
  readonly message: string;
  readonly user: JwtAccessPayload | null;
};

/**
 * Transitional compatibility shim for the handshake contract.
 * Default/current mode is `PayloadFrame`; `raw_json` exists only for narrow, time-boxed migrations.
 */
export const buildConnectionReadyPayloadForWire = (
  payload: ConnectionReadyPayload,
): ConnectionReadyPayload | ReturnType<typeof encodePayloadFrame> => {
  if (env.socketConnectionReadyCompatMode === "raw_json") {
    return payload;
  }
  return encodePayloadFrame(payload, { requestId: "handshake", omitTraceId: true });
};

export const emitConnectionReady = (
  socket: Socket,
  payload: ConnectionReadyPayload,
): void => {
  socket.emit(socketEvents.connectionReady, buildConnectionReadyPayloadForWire(payload));
};
