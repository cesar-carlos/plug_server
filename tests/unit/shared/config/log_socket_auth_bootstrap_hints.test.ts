import { afterEach, describe, expect, it, vi } from "vitest";

import { logSocketAuthBootstrapHints } from "../../../../src/shared/config/log_socket_auth_bootstrap_hints";
import { logger } from "../../../../src/shared/utils/logger";

describe("logSocketAuthBootstrapHints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits no warnings when SOCKET_AUTH_REQUIRED is true", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketAuthBootstrapHints({
      nodeEnv: "development",
      socketAuthRequired: true,
      socketAgentAuthBypassAllowed: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when test-only bypass is active", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketAuthBootstrapHints({
      nodeEnv: "test",
      socketAuthRequired: false,
      socketAgentAuthBypassAllowed: true,
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_agent_auth_bypass_test_only",
      expect.objectContaining({
        nodeEnv: "test",
      }),
    );
  });

  it("warns when SOCKET_AUTH_REQUIRED=false is ignored outside test", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketAuthBootstrapHints({
      nodeEnv: "development",
      socketAuthRequired: false,
      socketAgentAuthBypassAllowed: false,
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_agent_auth_bypass_ignored",
      expect.objectContaining({
        nodeEnv: "development",
      }),
    );
  });
});
