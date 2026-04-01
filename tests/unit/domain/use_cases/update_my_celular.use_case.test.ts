import { beforeEach, describe, expect, it, vi } from "vitest";

import { User } from "../../../../src/domain/entities/user.entity";
import { UpdateMyCelularUseCase } from "../../../../src/domain/use_cases/update_my_celular.use_case";

const makeUser = (overrides?: Partial<{ id: string; celular?: string }>): User =>
  new User({
    id: overrides?.id ?? "u1",
    email: "a@b.com",
    passwordHash: "h",
    role: "user",
    status: "active",
    createdAt: new Date(),
    ...(overrides?.celular !== undefined ? { celular: overrides.celular } : {}),
  });

describe("UpdateMyCelularUseCase", () => {
  const findById = vi.fn();
  const findByCelular = vi.fn();
  const save = vi.fn();

  const useCase = new UpdateMyCelularUseCase({
    findById,
    findByCelular,
    save,
  } as never);

  beforeEach(() => {
    findById.mockReset();
    findByCelular.mockReset();
    save.mockReset();
  });

  it("returns conflict when new celular is taken by another user", async () => {
    const me = makeUser({ id: "me", celular: "+5511999999999" });
    findById.mockResolvedValue(me);
    findByCelular.mockResolvedValue(makeUser({ id: "other", celular: "+5511888888888" }));

    const result = await useCase.execute({
      userId: "me",
      celular: "+5511888888888",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("clears celular when null is sent", async () => {
    const me = makeUser({ celular: "+5511987654321" });
    findById.mockResolvedValue(me);

    const result = await useCase.execute({ userId: me.id, celular: null });

    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    if (result.ok) {
      expect(result.value.celular).toBeUndefined();
    }
  });
});
