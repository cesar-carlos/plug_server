import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import { err, ok } from "../../../../../src/shared/errors/result";

vi.mock("../../../../../src/presentation/socket/auth/ensure_socket_active_account", () => ({
  assertJwtUserAccountActive: vi.fn(),
}));

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    agentAccessService: {
      assertPrincipalAccess: vi.fn(),
    },
  },
}));

import {
  assertConsumerSocketAgentAccess,
  resolveConsumerAgentAccessPrincipal,
  resolveSocketActorRole,
} from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { assertJwtUserAccountActive } from "../../../../../src/presentation/socket/auth/ensure_socket_active_account";
import { container } from "../../../../../src/shared/di/container";

const mockedAssertJwtUserAccountActive = vi.mocked(assertJwtUserAccountActive);
const mockedAssertPrincipalAccess = vi.mocked(container.agentAccessService.assertPrincipalAccess);

describe("consumer_socket_guard", () => {
  beforeEach(() => {
    mockedAssertJwtUserAccountActive.mockReset();
    mockedAssertPrincipalAccess.mockReset();
  });

  it("resolves actor role only for non-empty role strings", () => {
    expect(resolveSocketActorRole({ role: "admin" } as never)).toBe("admin");
    expect(resolveSocketActorRole({ role: "   " } as never)).toBeNull();
    expect(resolveSocketActorRole(undefined)).toBeNull();
  });

  it("resolves user and client principals from jwt payloads", () => {
    expect(
      resolveConsumerAgentAccessPrincipal({
        sub: "user-1",
        principal_type: "user",
        role: "admin",
      } as never),
    ).toEqual({
      type: "user",
      id: "user-1",
      role: "admin",
    });

    expect(
      resolveConsumerAgentAccessPrincipal({
        sub: "client-1",
        principal_type: "client",
      } as never),
    ).toEqual({
      type: "client",
      id: "client-1",
    });
  });

  it("returns null principal when jwt sub is missing", () => {
    expect(resolveConsumerAgentAccessPrincipal({ principal_type: "user" } as never)).toBeNull();
  });

  it("returns resolved principal when active account and agent access are valid", async () => {
    mockedAssertJwtUserAccountActive.mockResolvedValue({
      sub: "user-1",
      principal_type: "user",
      role: "user",
    } as never);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));

    await expect(
      assertConsumerSocketAgentAccess(
        {
          sub: "user-1",
          principal_type: "user",
          role: "user",
        } as never,
        "agent-1",
      ),
    ).resolves.toEqual({
      type: "user",
      id: "user-1",
      role: "user",
    });

    expect(mockedAssertPrincipalAccess).toHaveBeenCalledWith(
      { type: "user", id: "user-1", role: "user" },
      "agent-1",
    );
  });

  it("throws unauthorized when principal cannot be resolved after active-account check", async () => {
    mockedAssertJwtUserAccountActive.mockResolvedValue({} as never);

    await expect(assertConsumerSocketAgentAccess(undefined, "agent-1")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      statusCode: 401,
    });
  });

  it("rethrows agent access denial from the application service", async () => {
    const denial = new AppError("Agent denied", {
      statusCode: 403,
      code: "AGENT_ACCESS_DENIED",
    });

    mockedAssertJwtUserAccountActive.mockResolvedValue({
      sub: "client-1",
      principal_type: "client",
    } as never);
    mockedAssertPrincipalAccess.mockResolvedValue(err(denial));

    await expect(
      assertConsumerSocketAgentAccess(
        {
          sub: "client-1",
          principal_type: "client",
        } as never,
        "agent-9",
      ),
    ).rejects.toBe(denial);
  });
});
