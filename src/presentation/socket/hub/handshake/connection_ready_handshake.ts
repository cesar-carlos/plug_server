import type { Socket } from "socket.io";

import { env } from "../../../../shared/config/env";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { encodePayloadFrameHotPath } from "../../../../shared/utils/payload_frame";
import type { JwtAccessPayload } from "../../../../shared/utils/jwt";
import { logger } from "../../../../shared/utils/logger";

export const CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER = "2026-09-30";

const connectionReadyLegacyCompatRemovalInstant = (): number =>
  Date.parse(`${CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER}T23:59:59.999Z`);

/**
 * Boot warning when the documented removal date for `SOCKET_CONNECTION_READY_COMPAT_MODE=raw_json`
 * has passed. Per `governance.mdc` exception tracking.
 */
export const warnIfConnectionReadyLegacyCompatExpired = (
  nowMs: number = Date.now(),
  compatMode: typeof env.socketConnectionReadyCompatMode = env.socketConnectionReadyCompatMode,
): void => {
  if (nowMs <= connectionReadyLegacyCompatRemovalInstant()) {
    return;
  }

  logger.warn("connection_ready_legacy_compat_past_removal_date", {
    removeAfter: CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER,
    compatMode,
    remediation:
      "Delete raw_json compat in connection_ready_handshake.ts and remove SOCKET_CONNECTION_READY_COMPAT_MODE from env/docs.",
  });
};

export type ConnectionReadyPayload = {
  readonly id: string;
  readonly message: string;
  readonly user: JwtAccessPayload | null;
};

type ConnectionReadyWirePayload = ConnectionReadyPayload & {
  readonly relay: {
    readonly batch: {
      readonly enabled: boolean;
      readonly maxItems: number;
    };
  };
};

const withRelayCapabilities = (payload: ConnectionReadyPayload): ConnectionReadyWirePayload => ({
  ...payload,
  relay: {
    batch: {
      enabled: env.socketRelayBatchEnabled,
      maxItems: env.socketRelayBatchMaxItems,
    },
  },
});

/**
 * Transitional compatibility shim for the handshake contract.
 * Default/current mode is `PayloadFrame`; `raw_json` exists only for narrow, time-boxed migrations.
 * Uses hot-path encode (`cmp: none`) so connection storms never hit sync gzip on the event loop.
 */
export const buildConnectionReadyPayloadForWire = (
  payload: ConnectionReadyPayload,
  options: { readonly includeRelayBatchCapabilities?: boolean } = {},
):
  | ConnectionReadyPayload
  | ConnectionReadyWirePayload
  | ReturnType<typeof encodePayloadFrameHotPath> => {
  const wirePayload = options.includeRelayBatchCapabilities
    ? withRelayCapabilities(payload)
    : payload;
  if (env.socketConnectionReadyCompatMode === "raw_json") {
    return wirePayload;
  }
  return encodePayloadFrameHotPath(wirePayload, { requestId: "handshake" });
};

export const emitConnectionReady = (
  socket: Socket,
  payload: ConnectionReadyPayload,
  options: { readonly includeRelayBatchCapabilities?: boolean } = {},
): void => {
  socket.emit(socketEvents.connectionReady, buildConnectionReadyPayloadForWire(payload, options));
};
