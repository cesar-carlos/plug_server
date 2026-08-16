import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../../../src/application/services/auth.service";
import { User } from "../../../../src/domain/entities/user.entity";
import type { UserActiveSnapshot } from "../../../../src/domain/repositories/user.repository.interface";
import { env } from "../../../../src/shared/config/env";
import type { JwtAccessPayload } from "../../../../src/shared/utils/jwt";

const originalSnapshotTtl = env.principalSnapshotCacheTtlMs;

const makeUser = (
  overrides: {
    readonly id?: string;
    readonly email?: string;
    readonly celular?: string;
    readonly role?: "user" | "admin";
    readonly status?: "pending" | "active" | "rejected" | "blocked";
    readonly credentialsUpdatedAt?: Date;
  } = {},
): User =>
  User.create({
    id: overrides.id ?? "u1",
    email: overrides.email ?? "a@b.com",
    passwordHash: "h",
    role: overrides.role ?? "user",
    status: overrides.status ?? "active",
    ...(overrides.celular !== undefined ? { celular: overrides.celular } : {}),
    ...(overrides.credentialsUpdatedAt !== undefined
      ? { credentialsUpdatedAt: overrides.credentialsUpdatedAt }
      : {}),
  });

const toSnapshot = (user: User): UserActiveSnapshot => ({
  id: user.id,
  status: user.status,
  credentialsUpdatedAt: user.credentialsUpdatedAt,
  role: user.role,
});

const makeAccessPayload = (
  user: User,
  overrides: Partial<JwtAccessPayload> = {},
): JwtAccessPayload => ({
  sub: user.id,
  email: user.email,
  role: user.role,
  principal_type: "user",
  credentials_version: user.credentialsUpdatedAt.getTime(),
  tokenType: "access",
  ...overrides,
});

const makeService = (userRepo: {
  findById: ReturnType<typeof vi.fn>;
  findActiveSnapshotById?: ReturnType<typeof vi.fn>;
  save?: ReturnType<typeof vi.fn>;
}): AuthService =>
  new AuthService(
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { save: vi.fn(), revokeAllForUser: vi.fn() } as never,
    {
      findById: userRepo.findById,
      findActiveSnapshotById: userRepo.findActiveSnapshotById ?? vi.fn(),
      save: userRepo.save ?? vi.fn(),
    } as never,
    {} as never,
  );

describe("AuthService getActiveAccountUser", () => {
  const findById = vi.fn();

  beforeEach(() => {
    findById.mockReset();
  });

  it("does not call findById when preloaded id matches userId and user is active", async () => {
    const u = makeUser();
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("u1");
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it("returns forbidden when preloaded id matches but status is blocked", async () => {
    const u = makeUser({ status: "blocked" });
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it("returns invalid token when preloaded credentials are newer than the access token", async () => {
    const u = makeUser({ credentialsUpdatedAt: new Date(2_000) });
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u, 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it("calls findById when preloaded id differs from userId", async () => {
    const u = makeUser({ id: "other" });
    findById.mockResolvedValue(makeUser());
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u);
    expect(result.ok).toBe(true);
    expect(findById).toHaveBeenCalledWith("u1");
  });

  it("returns not found when the user is missing", async () => {
    findById.mockResolvedValue(null);
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns forbidden when the persisted user is blocked", async () => {
    findById.mockResolvedValue(makeUser({ status: "blocked" }));
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("returns invalid token when persisted credentials are newer than the access token", async () => {
    findById.mockResolvedValue(makeUser({ credentialsUpdatedAt: new Date(5_000) }));
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", undefined, 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
  });
});

describe("AuthService assertAccountNotBlocked", () => {
  it("returns ok for an active account", async () => {
    const findById = vi.fn().mockResolvedValue(makeUser());
    const service = makeService({ findById });
    const result = await service.assertAccountNotBlocked("u1");
    expect(result.ok).toBe(true);
  });

  it("propagates getActiveAccountUser failures", async () => {
    const findById = vi.fn().mockResolvedValue(null);
    const service = makeService({ findById });
    const result = await service.assertAccountNotBlocked("missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("AuthService getActiveAccountUserSnapshot", () => {
  const findActiveSnapshotById = vi.fn();
  const findById = vi.fn();

  beforeEach(() => {
    findActiveSnapshotById.mockReset();
    findById.mockReset();
    (env as { principalSnapshotCacheTtlMs: number }).principalSnapshotCacheTtlMs = 60_000;
  });

  afterEach(() => {
    (env as { principalSnapshotCacheTtlMs: number }).principalSnapshotCacheTtlMs =
      originalSnapshotTtl;
  });

  it("caches snapshots keyed by user id and credentials version", async () => {
    const user = makeUser({ credentialsUpdatedAt: new Date(1_700_000_000_100) });
    findActiveSnapshotById.mockResolvedValue(toSnapshot(user));
    const service = makeService({ findById, findActiveSnapshotById });

    const first = await service.getActiveAccountUserSnapshot(
      user.id,
      user.credentialsUpdatedAt.getTime(),
    );
    const second = await service.getActiveAccountUserSnapshot(
      user.id,
      user.credentialsUpdatedAt.getTime(),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(findActiveSnapshotById).toHaveBeenCalledOnce();
  });

  it("skips the cache when snapshot ttl is disabled", async () => {
    (env as { principalSnapshotCacheTtlMs: number }).principalSnapshotCacheTtlMs = 0;
    const user = makeUser();
    findActiveSnapshotById.mockResolvedValue(toSnapshot(user));
    const service = makeService({ findById, findActiveSnapshotById });

    await service.getActiveAccountUserSnapshot(user.id, user.credentialsUpdatedAt.getTime());
    await service.getActiveAccountUserSnapshot(user.id, user.credentialsUpdatedAt.getTime());

    expect(findActiveSnapshotById).toHaveBeenCalledTimes(2);
  });

  it("does not cache when credentials version is omitted", async () => {
    const user = makeUser();
    findActiveSnapshotById.mockResolvedValue(toSnapshot(user));
    const service = makeService({ findById, findActiveSnapshotById });

    await service.getActiveAccountUserSnapshot(user.id);
    await service.getActiveAccountUserSnapshot(user.id);

    expect(findActiveSnapshotById).toHaveBeenCalledTimes(2);
  });

  it("returns not found when the snapshot is missing", async () => {
    findActiveSnapshotById.mockResolvedValue(null);
    const service = makeService({ findById, findActiveSnapshotById });
    const result = await service.getActiveAccountUserSnapshot("missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns forbidden when the snapshot is blocked", async () => {
    findActiveSnapshotById.mockResolvedValue(toSnapshot(makeUser({ status: "blocked" })));
    const service = makeService({ findById, findActiveSnapshotById });
    const result = await service.getActiveAccountUserSnapshot("u1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("returns invalid token when snapshot credentials are newer than the access token", async () => {
    findActiveSnapshotById.mockResolvedValue(
      toSnapshot(makeUser({ credentialsUpdatedAt: new Date(9_000) })),
    );
    const service = makeService({ findById, findActiveSnapshotById });
    const result = await service.getActiveAccountUserSnapshot("u1", 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
  });

  it("evicts cached snapshots for a user id", async () => {
    const user = makeUser({ credentialsUpdatedAt: new Date(1_700_000_000_100) });
    findActiveSnapshotById.mockResolvedValue(toSnapshot(user));
    const service = makeService({ findById, findActiveSnapshotById });

    await service.getActiveAccountUserSnapshot(user.id, user.credentialsUpdatedAt.getTime());
    service.invalidateSnapshotCache(user.id);
    await service.getActiveAccountUserSnapshot(user.id, user.credentialsUpdatedAt.getTime());

    expect(findActiveSnapshotById).toHaveBeenCalledTimes(2);
  });
});

describe("AuthService getMeProfile", () => {
  it("maps not found from the active-account lookup", async () => {
    const service = makeService({ findById: vi.fn().mockResolvedValue(null) });
    const result = await service.getMeProfile(makeAccessPayload(makeUser()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("propagates non-not-found active-account errors", async () => {
    const service = makeService({
      findById: vi.fn().mockResolvedValue(makeUser({ status: "blocked" })),
    });
    const result = await service.getMeProfile(makeAccessPayload(makeUser()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("uses the jwt role and agent id when they are present", async () => {
    const user = makeUser({ celular: "+5511987654321" });
    const service = makeService({ findById: vi.fn() });
    const result = await service.getMeProfile(
      makeAccessPayload(user, { role: "agent", agent_id: "agent-7" }),
      user,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({
      id: user.id,
      sub: user.id,
      email: user.email,
      role: "agent",
      status: user.status,
      celular: "+5511987654321",
      agentId: "agent-7",
    });
  });

  it("falls back to the domain role and omits blank jwt fields", async () => {
    const user = makeUser();
    const service = makeService({ findById: vi.fn() });
    const result = await service.getMeProfile(
      makeAccessPayload(user, { role: "   ", agent_id: "   " }),
      user,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.role).toBe("user");
    expect(result.value.celular).toBeUndefined();
    expect(result.value.agentId).toBeUndefined();
  });
});
