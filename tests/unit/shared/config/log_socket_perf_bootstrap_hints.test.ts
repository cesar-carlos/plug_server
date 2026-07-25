import { afterEach, describe, expect, it, vi } from "vitest";

import { logSocketPerfBootstrapHints } from "../../../../src/shared/config/log_socket_perf_bootstrap_hints";
import { logger } from "../../../../src/shared/utils/logger";

const productionOk = {
  nodeEnv: "production",
  socketIoPerMessageDeflate: false,
  socketIoTransports: ["websocket"] as const,
  payloadFrameGzipLevel: 3 as number | undefined,
  socketAuthAccountSnapshotTtlMs: 15_000,
  socketConsumerAgentAccessSnapshotTtlMs: 15_000,
};

describe("logSocketPerfBootstrapHints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits no logs outside production", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    logSocketPerfBootstrapHints({
      ...productionOk,
      nodeEnv: "development",
      socketIoPerMessageDeflate: true,
      socketIoTransports: ["websocket", "polling"],
      payloadFrameGzipLevel: 9,
      socketAuthAccountSnapshotTtlMs: 0,
      socketConsumerAgentAccessSnapshotTtlMs: 0,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("emits no warnings when production transport settings are healthy", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    logSocketPerfBootstrapHints(productionOk);

    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("warns when permessage-deflate is enabled in production", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketPerfBootstrapHints({
      ...productionOk,
      socketIoPerMessageDeflate: true,
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_io_per_message_deflate_enabled_in_production",
      expect.objectContaining({
        remediation: expect.stringContaining("SOCKET_IO_PER_MESSAGE_DEFLATE"),
      }),
    );
  });

  it("warns when polling is enabled in production", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketPerfBootstrapHints({
      ...productionOk,
      socketIoTransports: ["websocket", "polling"],
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_io_polling_enabled_in_production",
      expect.objectContaining({
        transports: ["websocket", "polling"],
      }),
    );
  });

  it("warns when gzip level is above 3 in production", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketPerfBootstrapHints({
      ...productionOk,
      payloadFrameGzipLevel: 6,
    });

    expect(warn).toHaveBeenCalledWith(
      "payload_frame_gzip_level_high_in_production",
      expect.objectContaining({
        payloadFrameGzipLevel: 6,
      }),
    );
  });

  it("logs info when both snapshot TTLs are zero in production", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    logSocketPerfBootstrapHints({
      ...productionOk,
      socketAuthAccountSnapshotTtlMs: 0,
      socketConsumerAgentAccessSnapshotTtlMs: 0,
    });

    expect(info).toHaveBeenCalledWith(
      "socket_auth_snapshot_ttls_disabled_in_production",
      expect.objectContaining({
        message: expect.stringContaining("SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS"),
      }),
    );
  });
});
