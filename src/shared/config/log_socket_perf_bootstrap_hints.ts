import { env } from "./env";
import { logger } from "../utils/logger";

export type SocketPerfBootstrapEnvSlice = {
  readonly nodeEnv: string;
  readonly socketIoPerMessageDeflate: boolean;
  readonly socketIoTransports: readonly string[];
  readonly payloadFrameGzipLevel: number | undefined;
  readonly socketAuthAccountSnapshotTtlMs: number;
  readonly socketConsumerAgentAccessSnapshotTtlMs: number;
};

/**
 * Production boot hints for Socket transport CPU settings and optional auth
 * snapshot TTLs. Defaults in `env.ts` are already production-friendly; this
 * warns when operators override them into costly combinations.
 */
export const logSocketPerfBootstrapHints = (
  slice: SocketPerfBootstrapEnvSlice = {
    nodeEnv: env.nodeEnv,
    socketIoPerMessageDeflate: env.socketIoPerMessageDeflate,
    socketIoTransports: env.socketIoTransports,
    payloadFrameGzipLevel: env.payloadFrameGzipLevel,
    socketAuthAccountSnapshotTtlMs: env.socketAuthAccountSnapshotTtlMs,
    socketConsumerAgentAccessSnapshotTtlMs: env.socketConsumerAgentAccessSnapshotTtlMs,
  },
): void => {
  if (slice.nodeEnv !== "production") {
    return;
  }

  if (slice.socketIoPerMessageDeflate) {
    logger.warn("socket_io_per_message_deflate_enabled_in_production", {
      remediation:
        "Set SOCKET_IO_PER_MESSAGE_DEFLATE=false (default). PayloadFrame already applies optional gzip; Engine.IO deflate doubles CPU.",
    });
  }

  if (slice.socketIoTransports.includes("polling")) {
    logger.warn("socket_io_polling_enabled_in_production", {
      transports: slice.socketIoTransports,
      remediation:
        "Prefer SOCKET_IO_TRANSPORTS=websocket (or unset in production for the websocket-only default) to avoid long-polling handshake/CPU overhead.",
    });
  }

  if (slice.payloadFrameGzipLevel !== undefined && slice.payloadFrameGzipLevel > 3) {
    logger.warn("payload_frame_gzip_level_high_in_production", {
      payloadFrameGzipLevel: slice.payloadFrameGzipLevel,
      remediation:
        "Set PAYLOAD_FRAME_GZIP_LEVEL=1..3 (production default when unset is 3) to reduce zlib CPU on high-throughput hubs.",
    });
  }

  if (
    slice.socketAuthAccountSnapshotTtlMs === 0 &&
    slice.socketConsumerAgentAccessSnapshotTtlMs === 0
  ) {
    logger.info("socket_auth_snapshot_ttls_disabled_in_production", {
      message:
        "SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS and SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS are 0 (DB check on every sensitive consumer event).",
      remediation:
        "Opt-in short TTLs (e.g. 15000–30000 for account, 15000 for agent access) reduce DB load; block/revoke may lag up to the TTL unless invalidation hooks fire. See docs/performance/performance_hub_agent.md.",
    });
  }
};
