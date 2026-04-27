import { afterEach, describe, expect, it, vi } from "vitest";

import { logSocketConsumerBootstrapHints } from "../../../../src/shared/config/log_socket_consumer_bootstrap_hints";
import { logger } from "../../../../src/shared/utils/logger";

describe("logSocketConsumerBootstrapHints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when profile push is disabled", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketConsumerBootstrapHints({
      socketConsumerRoles: ["user", "admin", "client"],
      socketConsumerRolesClientAppended: false,
      socketClientAgentProfilePushEnabled: false,
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_client_agent_profile_push_disabled",
      expect.objectContaining({
        remediation: expect.stringContaining("SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED"),
      }),
    );
  });

  it("logs when client role was appended to SOCKET_CONSUMER_ROLES", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    logSocketConsumerBootstrapHints({
      socketConsumerRoles: ["user", "admin", "client"],
      socketConsumerRolesClientAppended: true,
      socketClientAgentProfilePushEnabled: true,
    });

    expect(info).toHaveBeenCalledWith(
      "socket_consumer_roles_ensured_client",
      expect.objectContaining({
        effectiveRoles: ["user", "admin", "client"],
      }),
    );
  });

  it("emits no warnings when roles include client and push is enabled", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    logSocketConsumerBootstrapHints({
      socketConsumerRoles: ["user", "admin", "client"],
      socketConsumerRolesClientAppended: false,
      socketClientAgentProfilePushEnabled: true,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
