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

vi.mock("../../../../../src/presentation/socket/hub/consumer_identity_rooms", () => ({
  joinConsumerClientAgentRoom: vi.fn(),
}));

import {
  assertConsumerSocketAgentAccess,
  clearAllConsumerSocketAgentAccessSnapshots,
  clearConsumerSocketAgentAccessSnapshot,
  clearInflightAgentAccessForSocket,
  getSocketIdsWithAgentAccessSnapshot,
  getSocketIdsWithPrincipalKey,
  invalidateLocalAgentAccessSnapshotsByAgentId,
  invalidateLocalClientAgentAccessSnapshot,
  invalidateLocalUserAccessSnapshots,
  resolveConsumerAgentAccessPrincipal,
  resolveSocketActorRole,
} from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { assertJwtUserAccountActive } from "../../../../../src/presentation/socket/auth/ensure_socket_active_account";
import { joinConsumerClientAgentRoom } from "../../../../../src/presentation/socket/hub/consumer_identity_rooms";
import { container } from "../../../../../src/shared/di/container";
import { env } from "../../../../../src/shared/config/env";

const mockedAssertJwtUserAccountActive = vi.mocked(assertJwtUserAccountActive);
const mockedAssertPrincipalAccess = vi.mocked(container.agentAccessService.assertPrincipalAccess);
const mockedJoinConsumerClientAgentRoom = vi.mocked(joinConsumerClientAgentRoom);

describe("consumer_socket_guard", () => {
  beforeEach(() => {
    mockedAssertJwtUserAccountActive.mockReset();
    mockedAssertPrincipalAccess.mockReset();
    mockedJoinConsumerClientAgentRoom.mockReset();
    env.socketConsumerAgentAccessSnapshotTtlMs = 0;
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

  it("reuses per-socket agent access snapshot within TTL without hitting assertPrincipalAccess", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "client-1",
      principal_type: "client",
      credentials_version: 2,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));
    mockedJoinConsumerClientAgentRoom.mockResolvedValue(undefined);

    const socket = {
      id: "socket-1",
      data: {},
    } as never;

    await expect(assertConsumerSocketAgentAccess(user, "agent-1", socket)).resolves.toEqual({
      type: "client",
      id: "client-1",
    });
    await expect(assertConsumerSocketAgentAccess(user, "agent-1", socket)).resolves.toEqual({
      type: "client",
      id: "client-1",
    });

    expect(mockedAssertPrincipalAccess).toHaveBeenCalledTimes(1);
    expect(mockedJoinConsumerClientAgentRoom).toHaveBeenCalledTimes(1);
  });

  it("revalidates agent access after per-socket snapshot TTL expires", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 1_000;
    vi.useFakeTimers();
    const user = {
      sub: "user-1",
      principal_type: "user",
      role: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));

    const socket = {
      id: "socket-2",
      data: {},
    } as never;

    try {
      await assertConsumerSocketAgentAccess(user, "agent-9", socket);
      vi.advanceTimersByTime(1_001);
      await assertConsumerSocketAgentAccess(user, "agent-9", socket);
      expect(mockedAssertPrincipalAccess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearConsumerSocketAgentAccessSnapshot removes cached entry so guard revalidates", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "client-1",
      principal_type: "client",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));
    mockedJoinConsumerClientAgentRoom.mockResolvedValue(undefined);

    const socket = {
      id: "socket-3",
      data: {},
    } as never;

    await assertConsumerSocketAgentAccess(user, "agent-1", socket);
    expect(mockedAssertPrincipalAccess).toHaveBeenCalledTimes(1);

    clearConsumerSocketAgentAccessSnapshot(socket, "agent-1");
    await assertConsumerSocketAgentAccess(user, "agent-1", socket);
    expect(mockedAssertPrincipalAccess).toHaveBeenCalledTimes(2);
  });

  it("clearAllConsumerSocketAgentAccessSnapshots removes all cached entries", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "user-1",
      principal_type: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));

    const socket = {
      id: "socket-4",
      data: {},
    } as never;

    await assertConsumerSocketAgentAccess(user, "agent-1", socket);
    await assertConsumerSocketAgentAccess(user, "agent-2", socket);
    expect(mockedAssertPrincipalAccess).toHaveBeenCalledTimes(2);

    clearAllConsumerSocketAgentAccessSnapshots(socket);
    await assertConsumerSocketAgentAccess(user, "agent-1", socket);
    await assertConsumerSocketAgentAccess(user, "agent-2", socket);
    expect(mockedAssertPrincipalAccess).toHaveBeenCalledTimes(4);
  });

  it("clearAllConsumerSocketAgentAccessSnapshots removes socket from reverse index", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "user-1",
      principal_type: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));

    const socket = {
      id: "socket-reverse-index",
      data: {},
    } as never;

    await assertConsumerSocketAgentAccess(user, "agent-1", socket);
    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").has("socket-reverse-index")).toBe(true);

    clearAllConsumerSocketAgentAccessSnapshots(socket);
    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").has("socket-reverse-index")).toBe(false);
  });

  it("clearInflightAgentAccessForSocket prevents snapshot when validation completes after disconnect", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "user-1",
      principal_type: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);

    let releaseAccessCheck!: () => void;
    const accessGate = new Promise<void>((resolve) => {
      releaseAccessCheck = resolve;
    });
    mockedAssertPrincipalAccess.mockImplementation(async () => {
      await accessGate;
      return ok(undefined);
    });

    const socket = {
      id: "socket-inflight-disconnect",
      data: {},
    } as never;

    const validation = assertConsumerSocketAgentAccess(user, "agent-1", socket);
    await Promise.resolve();
    clearInflightAgentAccessForSocket("socket-inflight-disconnect");
    releaseAccessCheck();
    await validation;

    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").has("socket-inflight-disconnect")).toBe(
      false,
    );
    expect(socket.data.agentAccessSnapshots?.has("agent-1") ?? false).toBe(false);
  });

  it("clearInflightAgentAccessForSocket clears multiple concurrent agent validations for one socket", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "user-1",
      principal_type: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);

    let releaseAccessCheck!: () => void;
    const accessGate = new Promise<void>((resolve) => {
      releaseAccessCheck = resolve;
    });
    mockedAssertPrincipalAccess.mockImplementation(async () => {
      await accessGate;
      return ok(undefined);
    });

    const socket = {
      id: "socket-inflight-multi-agent",
      data: {},
    } as never;

    const validation1 = assertConsumerSocketAgentAccess(user, "agent-1", socket);
    const validation2 = assertConsumerSocketAgentAccess(user, "agent-2", socket);
    await Promise.resolve();
    clearInflightAgentAccessForSocket("socket-inflight-multi-agent");
    releaseAccessCheck();
    await Promise.all([validation1, validation2]);

    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").has("socket-inflight-multi-agent")).toBe(
      false,
    );
    expect(getSocketIdsWithAgentAccessSnapshot("agent-2").has("socket-inflight-multi-agent")).toBe(
      false,
    );
    expect(socket.data.agentAccessSnapshots?.has("agent-1") ?? false).toBe(false);
    expect(socket.data.agentAccessSnapshots?.has("agent-2") ?? false).toBe(false);
  });

  it("invalidateLocalAgentAccessSnapshotsByAgentId clears local sockets and prunes stale index entries", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "user-1",
      principal_type: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));

    const localSocket = {
      id: "socket-local",
      data: { user },
    } as never;
    const staleSocket = {
      id: "socket-stale",
      data: { user },
    } as never;
    const namespace = {
      sockets: {
        get: (socketId: string) => (socketId === "socket-local" ? localSocket : undefined),
      },
    };

    await assertConsumerSocketAgentAccess(user, "agent-1", staleSocket);
    await assertConsumerSocketAgentAccess(user, "agent-1", localSocket);
    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").has("socket-stale")).toBe(true);
    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").has("socket-local")).toBe(true);

    const cleared = invalidateLocalAgentAccessSnapshotsByAgentId(namespace, "agent-1");
    expect(cleared).toBe(1);
    expect(localSocket.data.agentAccessSnapshots?.has("agent-1") ?? false).toBe(false);
    expect(getSocketIdsWithAgentAccessSnapshot("agent-1").size).toBe(0);
  });

  it("invalidateLocalClientAgentAccessSnapshot clears only matching client sockets", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const clientUser = {
      sub: "client-1",
      principal_type: "client",
      credentials_version: 1,
    } as never;
    const otherClientUser = {
      sub: "client-2",
      principal_type: "client",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockImplementation(async (user) => user as never);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));
    mockedJoinConsumerClientAgentRoom.mockResolvedValue(undefined);

    const clientSocket = { id: "socket-client-1", data: { user: clientUser } } as never;
    const otherSocket = { id: "socket-client-2", data: { user: otherClientUser } } as never;
    const namespace = {
      sockets: {
        get: (socketId: string) => {
          if (socketId === "socket-client-1") return clientSocket;
          if (socketId === "socket-client-2") return otherSocket;
          return undefined;
        },
      },
    };

    await assertConsumerSocketAgentAccess(clientUser, "agent-1", clientSocket);
    await assertConsumerSocketAgentAccess(otherClientUser, "agent-1", otherSocket);

    const cleared = invalidateLocalClientAgentAccessSnapshot(namespace, "client-1", "agent-1");
    expect(cleared).toBe(1);
    expect(clientSocket.data.agentAccessSnapshots?.has("agent-1") ?? false).toBe(false);
    expect(otherSocket.data.agentAccessSnapshots?.has("agent-1") ?? false).toBe(true);
  });

  it("invalidateLocalUserAccessSnapshots clears all snapshots for a user principal", async () => {
    env.socketConsumerAgentAccessSnapshotTtlMs = 60_000;
    const user = {
      sub: "user-9",
      principal_type: "user",
      credentials_version: 1,
    } as never;

    mockedAssertJwtUserAccountActive.mockResolvedValue(user);
    mockedAssertPrincipalAccess.mockResolvedValue(ok(undefined));

    const socket = { id: "socket-user-9", data: { user } } as never;
    const namespace = {
      sockets: {
        get: (socketId: string) => (socketId === "socket-user-9" ? socket : undefined),
      },
    };

    await assertConsumerSocketAgentAccess(user, "agent-1", socket);
    await assertConsumerSocketAgentAccess(user, "agent-2", socket);
    expect(getSocketIdsWithPrincipalKey("user:user-9").has("socket-user-9")).toBe(true);

    const cleared = invalidateLocalUserAccessSnapshots(namespace, "user-9");
    expect(cleared).toBe(1);
    expect(socket.data.agentAccessSnapshots?.size ?? 0).toBe(0);
    expect(getSocketIdsWithPrincipalKey("user:user-9").size).toBe(0);
  });
});
