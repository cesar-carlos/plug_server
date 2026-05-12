import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prismaClient } from "../../../src/infrastructure/database/prisma/client";

describe("Postgres citext email uniqueness (users / clients)", () => {
  let databaseAvailable = false;
  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();

  const suffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      await prismaClient.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
    }
  });

  afterEach(async () => {
    if (!databaseAvailable) {
      return;
    }
    if (createdClientIds.size > 0) {
      await prismaClient.client.deleteMany({ where: { id: { in: [...createdClientIds] } } });
      createdClientIds.clear();
    }
    if (createdUserIds.size > 0) {
      await prismaClient.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
      createdUserIds.clear();
    }
  });

  it("rejects a second user whose email only differs by letter casing", async () => {
    if (!databaseAvailable) {
      return;
    }

    const local = `citext-user-${suffix()}`;
    const email = `${local}@test.com`;
    const user = await prismaClient.user.create({
      data: {
        email,
        passwordHash: "hash",
        role: "user",
        status: "active",
      },
    });
    createdUserIds.add(user.id);

    await expect(
      prismaClient.user.create({
        data: {
          email: email.toUpperCase(),
          passwordHash: "hash2",
          role: "user",
          status: "active",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a second client whose email only differs by letter casing", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await prismaClient.user.create({
      data: {
        email: `citext-owner-${suffix()}@test.com`,
        passwordHash: "hash",
        role: "user",
        status: "active",
      },
    });
    createdUserIds.add(owner.id);

    const local = `citext-client-${suffix()}`;
    const email = `${local}@test.com`;
    const client = await prismaClient.client.create({
      data: {
        userId: owner.id,
        email,
        passwordHash: "hash",
        name: "C",
        lastName: "T",
        status: "pending",
      },
    });
    createdClientIds.add(client.id);

    await expect(
      prismaClient.client.create({
        data: {
          userId: owner.id,
          email: email.toUpperCase(),
          passwordHash: "hash2",
          name: "C2",
          lastName: "T2",
          status: "pending",
        },
      }),
    ).rejects.toThrow();
  });
});
