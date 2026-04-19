import { afterEach, describe, expect, it, vi } from "vitest";

import { logSocketConsumerBootstrapHints } from "../../../../src/shared/config/log_socket_consumer_bootstrap_hints";
import { logger } from "../../../../src/shared/utils/logger";

describe("logSocketConsumerBootstrapHints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when client role is missing from SOCKET_CONSUMER_ROLES", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketConsumerBootstrapHints({
      socketConsumerRoles: ["user", "admin"],
      socketClientAgentProfilePushEnabled: true,
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_consumer_roles_missing_client_role",
      expect.objectContaining({
        configuredRoles: ["user", "admin"],
        remediation: expect.stringContaining("client"),
      }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      "socket_client_agent_profile_push_disabled",
      expect.anything(),
    );
  });

  it("warns when profile push is disabled", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketConsumerBootstrapHints({
      socketConsumerRoles: ["user", "admin", "client"],
      socketClientAgentProfilePushEnabled: false,
    });

    expect(warn).toHaveBeenCalledWith(
      "socket_client_agent_profile_push_disabled",
      expect.objectContaining({
        remediation: expect.stringContaining("SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED"),
      }),
    );
  });

  it("emits no warnings when roles include client and push is enabled", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    logSocketConsumerBootstrapHints({
      socketConsumerRoles: ["user", "admin", "client"],
      socketClientAgentProfilePushEnabled: true,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
