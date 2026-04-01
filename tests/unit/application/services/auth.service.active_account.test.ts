import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../../../src/application/services/auth.service";
import { User } from "../../../../src/domain/entities/user.entity";

const makeService = (userRepo: { findById: ReturnType<typeof vi.fn> }): AuthService =>
  new AuthService(
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { hash: vi.fn(), compare: vi.fn() } as never,
    { save: vi.fn() } as never,
    {} as never,
    {} as never,
    userRepo as never,
  );

describe("AuthService getActiveAccountUser", () => {
  const findById = vi.fn();

  beforeEach(() => {
    findById.mockReset();
  });

  it("does not call findById when preloaded id matches userId and user is active", async () => {
    const u = new User({
      id: "u1",
      email: "a@b.com",
      passwordHash: "h",
      role: "user",
      status: "active",
      createdAt: new Date(),
    });
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("u1");
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it("returns forbidden when preloaded id matches but status is blocked", async () => {
    const u = new User({
      id: "u1",
      email: "a@b.com",
      passwordHash: "h",
      role: "user",
      status: "blocked",
      createdAt: new Date(),
    });
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it("calls findById when preloaded id differs from userId", async () => {
    const u = new User({
      id: "other",
      email: "a@b.com",
      passwordHash: "h",
      role: "user",
      status: "active",
      createdAt: new Date(),
    });
    findById.mockResolvedValue(
      new User({
        id: "u1",
        email: "a@b.com",
        passwordHash: "h",
        role: "user",
        status: "active",
        createdAt: new Date(),
      }),
    );
    const service = makeService({ findById });
    const result = await service.getActiveAccountUser("u1", u);
    expect(result.ok).toBe(true);
    expect(findById).toHaveBeenCalledWith("u1");
  });
});
