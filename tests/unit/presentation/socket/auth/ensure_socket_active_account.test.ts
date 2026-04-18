import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureJwtUserAccountActive } from "../../../../../src/presentation/socket/auth/ensure_socket_active_account";
import { forbidden, notFound } from "../../../../../src/shared/errors/http_errors";
import { err, ok } from "../../../../../src/shared/errors/result";
import * as authAccountMetrics from "../../../../../src/shared/metrics/auth_account.metrics";

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    authService: {
      getActiveAccountUserSnapshot: vi.fn(),
    },
  },
}));

import { container } from "../../../../../src/shared/di/container";

const mockedGetActive = vi.mocked(container.authService.getActiveAccountUserSnapshot);

const activeUserSnapshot = (id: string) =>
  ({
    id,
    status: "active" as const,
    credentialsUpdatedAt: new Date(0),
    role: "user",
  }) as const;

const userPayload = { sub: "u1", role: "user", tokenType: "access" as const };

describe("ensureJwtUserAccountActive", () => {
  beforeEach(() => {
    mockedGetActive.mockReset();
    authAccountMetrics.resetAuthAccountMetrics();
    vi.restoreAllMocks();
  });

  it("returns true and does not call next when account is active", async () => {
    mockedGetActive.mockResolvedValue(ok(activeUserSnapshot("u1")));
    const next = vi.fn();
    const incrementSpy = vi.spyOn(authAccountMetrics, "incrementAuthSocketBlocked");

    const allowed = await ensureJwtUserAccountActive(userPayload, next);

    expect(allowed).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(incrementSpy).not.toHaveBeenCalled();
  });

  it("returns false, calls next, and increments metric when blocked", async () => {
    mockedGetActive.mockResolvedValue(err(forbidden("Account is blocked")));
    const next = vi.fn();
    const incrementSpy = vi.spyOn(authAccountMetrics, "incrementAuthSocketBlocked");

    const allowed = await ensureJwtUserAccountActive(userPayload, next);

    expect(allowed).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    expect(incrementSpy).toHaveBeenCalledOnce();
  });

  it("returns false without incrementing socket metric for not found", async () => {
    mockedGetActive.mockResolvedValue(err(notFound("User")));
    const next = vi.fn();
    const incrementSpy = vi.spyOn(authAccountMetrics, "incrementAuthSocketBlocked");

    const allowed = await ensureJwtUserAccountActive(userPayload, next);

    expect(allowed).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    expect(incrementSpy).not.toHaveBeenCalled();
  });
});
