import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertJwtUserAccountActive,
  ensureJwtUserAccountActive,
} from "../../../../../src/presentation/socket/auth/ensure_socket_active_account";
import { forbidden, notFound } from "../../../../../src/shared/errors/http_errors";
import { err, ok } from "../../../../../src/shared/errors/result";
import * as authAccountMetrics from "../../../../../src/shared/metrics/auth_account.metrics";
import * as socketConsumerMetrics from "../../../../../src/shared/metrics/socket_consumer.metrics";

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketAuthAccountSnapshotTtlMs: 0,
  },
}));

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    authService: {
      getActiveAccountUserSnapshot: vi.fn(),
    },
    clientAuthService: {
      getActiveClientSnapshot: vi.fn(),
    },
  },
}));

import { env } from "../../../../../src/shared/config/env";
import { container } from "../../../../../src/shared/di/container";

const mockedGetActiveUser = vi.mocked(container.authService.getActiveAccountUserSnapshot);
const mockedGetActiveClient = vi.mocked(container.clientAuthService.getActiveClientSnapshot);

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
    env.socketAuthAccountSnapshotTtlMs = 0;
    mockedGetActiveUser.mockReset();
    mockedGetActiveClient.mockReset();
    authAccountMetrics.resetAuthAccountMetrics();
    socketConsumerMetrics.resetSocketConsumerMetrics();
    vi.restoreAllMocks();
  });

  it("returns true and does not call next when account is active", async () => {
    mockedGetActiveUser.mockResolvedValue(ok(activeUserSnapshot("u1")));
    const next = vi.fn();
    const incrementSpy = vi.spyOn(authAccountMetrics, "incrementAuthSocketBlocked");

    const allowed = await ensureJwtUserAccountActive(userPayload, next);

    expect(allowed).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(incrementSpy).not.toHaveBeenCalled();
  });

  it("returns false, calls next, and increments metric when blocked", async () => {
    mockedGetActiveUser.mockResolvedValue(err(forbidden("Account is blocked")));
    const next = vi.fn();
    const incrementSpy = vi.spyOn(authAccountMetrics, "incrementAuthSocketBlocked");

    const allowed = await ensureJwtUserAccountActive(userPayload, next, undefined, {
      recordConsumerBlockedMetric: true,
    });

    expect(allowed).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    expect(incrementSpy).toHaveBeenCalledOnce();
    expect(
      socketConsumerMetrics.getSocketConsumerMetricsSnapshot().authRejects.blocked_account,
    ).toBe(1);
  });

  it("returns false without incrementing consumer metric when blocked metric flag is omitted", async () => {
    mockedGetActiveUser.mockResolvedValue(err(forbidden("Account is blocked")));
    const next = vi.fn();

    const allowed = await ensureJwtUserAccountActive(userPayload, next);

    expect(allowed).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    expect(
      socketConsumerMetrics.getSocketConsumerMetricsSnapshot().authRejects.blocked_account,
    ).toBe(0);
  });

  it("returns false without incrementing socket metric for not found", async () => {
    mockedGetActiveUser.mockResolvedValue(err(notFound("User")));
    const next = vi.fn();
    const incrementSpy = vi.spyOn(authAccountMetrics, "incrementAuthSocketBlocked");

    const allowed = await ensureJwtUserAccountActive(userPayload, next);

    expect(allowed).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    expect(incrementSpy).not.toHaveBeenCalled();
  });
});

describe("assertJwtUserAccountActive", () => {
  beforeEach(() => {
    env.socketAuthAccountSnapshotTtlMs = 0;
    mockedGetActiveUser.mockReset();
    mockedGetActiveClient.mockReset();
    authAccountMetrics.resetAuthAccountMetrics();
    socketConsumerMetrics.resetSocketConsumerMetrics();
  });

  it("uses client auth service for client principals", async () => {
    mockedGetActiveClient.mockResolvedValue(
      ok({
        id: "client-1",
        status: "active",
        credentialsUpdatedAt: new Date(0),
      }),
    );

    await assertJwtUserAccountActive({
      sub: "client-1",
      principal_type: "client",
      tokenType: "access",
    });

    expect(mockedGetActiveClient).toHaveBeenCalledWith("client-1", undefined);
    expect(mockedGetActiveUser).not.toHaveBeenCalled();
  });

  it("skips DB validation when auth snapshot is still within TTL", async () => {
    env.socketAuthAccountSnapshotTtlMs = 60_000;
    const socket = {
      data: {
        authSnapshot: {
          subjectId: "u1",
          principalType: "user" as const,
          credentialsVersion: 7,
          validatedAtMs: Date.now(),
        },
      },
    };

    await assertJwtUserAccountActive(
      { sub: "u1", role: "user", tokenType: "access", credentials_version: 7 },
      socket as never,
    );

    expect(mockedGetActiveUser).not.toHaveBeenCalled();
  });

  it("revalidates against DB when credentials_version no longer matches snapshot", async () => {
    env.socketAuthAccountSnapshotTtlMs = 60_000;
    mockedGetActiveUser.mockResolvedValue(ok(activeUserSnapshot("u1")));
    const socket = {
      data: {
        authSnapshot: {
          subjectId: "u1",
          principalType: "user" as const,
          credentialsVersion: 1,
          validatedAtMs: Date.now(),
        },
      },
    };

    await assertJwtUserAccountActive(
      { sub: "u1", role: "user", tokenType: "access", credentials_version: 2 },
      socket as never,
    );

    expect(mockedGetActiveUser).toHaveBeenCalledWith("u1", 2);
    expect(socket.data.authSnapshot?.credentialsVersion).toBe(2);
  });

  it("dedupes concurrent DB validations for the same socket", async () => {
    let resolveDb!: () => void;
    mockedGetActiveUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDb = () => resolve(ok(activeUserSnapshot("u1")));
        }),
    );
    const socket = { id: "sock-1", data: {} as { authSnapshot?: unknown } };

    const first = assertJwtUserAccountActive(userPayload, socket as never);
    const second = assertJwtUserAccountActive(userPayload, socket as never);

    expect(mockedGetActiveUser).toHaveBeenCalledTimes(1);
    resolveDb();
    await Promise.all([first, second]);
    expect(socket.data.authSnapshot).toEqual(
      expect.objectContaining({
        subjectId: "u1",
        principalType: "user",
      }),
    );
  });
});
