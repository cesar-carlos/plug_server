import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RegistrationApprovalToken } from "../../../../src/domain/entities/registration_approval_token.entity";
import { prismaClient } from "../../../../src/infrastructure/database/prisma/client";
import { PrismaClientRegistrationDecisionTxn } from "../../../../src/infrastructure/persistence/prisma_client_registration_decision_txn";
import { PrismaRegistrationDecisionTxn } from "../../../../src/infrastructure/persistence/prisma_registration_decision_txn";
import { PrismaClientRegistrationApprovalTokenRepository } from "../../../../src/infrastructure/repositories/prisma_client_registration_approval_token.repository";
import { PrismaRegistrationApprovalTokenRepository } from "../../../../src/infrastructure/repositories/prisma_registration_approval_token.repository";

describe("Prisma registration decision transactions", () => {
  const userTxn = new PrismaRegistrationDecisionTxn();
  const clientTxn = new PrismaClientRegistrationDecisionTxn();
  const userTokenRepository = new PrismaRegistrationApprovalTokenRepository();
  const clientTokenRepository = new PrismaClientRegistrationApprovalTokenRepository();
  let databaseAvailable = false;

  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();

  const uniqueSuffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      await prismaClient.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
    }
  });

  beforeEach(() => {
    createdUserIds.clear();
    createdClientIds.clear();
  });

  afterEach(async () => {
    if (!databaseAvailable) {
      return;
    }
    if (createdClientIds.size > 0) {
      await prismaClient.clientRegistrationApprovalToken.deleteMany({
        where: { clientId: { in: Array.from(createdClientIds) } },
      });
      await prismaClient.client.deleteMany({
        where: { id: { in: Array.from(createdClientIds) } },
      });
    }
    if (createdUserIds.size > 0) {
      await prismaClient.registrationApprovalToken.deleteMany({
        where: { userId: { in: Array.from(createdUserIds) } },
      });
      await prismaClient.user.deleteMany({
        where: { id: { in: Array.from(createdUserIds) } },
      });
    }
  });

  const createUser = async (status: "pending" | "active" = "pending"): Promise<string> => {
    const suffix = uniqueSuffix();
    const user = await prismaClient.user.create({
      data: {
        email: `reg-decision-${suffix}@test.com`,
        passwordHash: "hash",
        role: "user",
        status,
      },
    });
    createdUserIds.add(user.id);
    return user.id;
  };

  const createClient = async (): Promise<string> => {
    const ownerId = await createUser("active");
    const suffix = uniqueSuffix();
    const client = await prismaClient.client.create({
      data: {
        userId: ownerId,
        email: `client-reg-decision-${suffix}@test.com`,
        passwordHash: "hash",
        name: "Txn",
        lastName: "Client",
        status: "pending",
      },
    });
    createdClientIds.add(client.id);
    return client.id;
  };

  it("serializes concurrent user approve/approve on one token", async () => {
    if (!databaseAvailable) {
      return;
    }
    const userId = await createUser();
    const tokenId = `user-approve-${randomUUID()}`;
    await userTokenRepository.save(
      new RegistrationApprovalToken({
        id: tokenId,
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const [first, second] = await Promise.all([userTxn.approve(tokenId), userTxn.approve(tokenId)]);
    const statuses = [first.status, second.status];

    expect(statuses.filter((status) => status === "approved")).toHaveLength(1);
    expect(statuses).toContain("not_found");
    expect((await prismaClient.user.findUnique({ where: { id: userId } }))?.status).toBe("active");
    expect(await userTokenRepository.findById(tokenId)).toBeNull();
  });

  it("serializes concurrent user approve/reject on one token", async () => {
    if (!databaseAvailable) {
      return;
    }
    const userId = await createUser();
    const tokenId = `user-decision-${randomUUID()}`;
    await userTokenRepository.save(
      new RegistrationApprovalToken({
        id: tokenId,
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const [approve, reject] = await Promise.all([
      userTxn.approve(tokenId),
      userTxn.reject(tokenId),
    ]);
    const statuses = [approve.status, reject.status];

    expect(
      statuses.filter((status) => status === "approved" || status === "rejected"),
    ).toHaveLength(1);
    expect(statuses).toContain("not_found");
    expect(["active", "rejected"]).toContain(
      (await prismaClient.user.findUnique({ where: { id: userId } }))?.status,
    );
    expect(await userTokenRepository.findById(tokenId)).toBeNull();
  });

  it("serializes concurrent client approve/approve on one token", async () => {
    if (!databaseAvailable) {
      return;
    }
    const clientId = await createClient();
    const tokenId = `client-approve-${randomUUID()}`;
    await clientTokenRepository.save({
      id: tokenId,
      clientId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [first, second] = await Promise.all([
      clientTxn.approve(tokenId),
      clientTxn.approve(tokenId),
    ]);
    const statuses = [first.status, second.status];

    expect(statuses.filter((status) => status === "approved")).toHaveLength(1);
    expect(statuses).toContain("not_found");
    expect((await prismaClient.client.findUnique({ where: { id: clientId } }))?.status).toBe(
      "active",
    );
    expect(await clientTokenRepository.findById(tokenId)).toBeNull();
  });

  it("serializes concurrent client approve/reject on one token", async () => {
    if (!databaseAvailable) {
      return;
    }
    const clientId = await createClient();
    const tokenId = `client-decision-${randomUUID()}`;
    await clientTokenRepository.save({
      id: tokenId,
      clientId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [approve, reject] = await Promise.all([
      clientTxn.approve(tokenId),
      clientTxn.reject(tokenId),
    ]);
    const statuses = [approve.status, reject.status];

    expect(
      statuses.filter((status) => status === "approved" || status === "rejected"),
    ).toHaveLength(1);
    expect(statuses).toContain("not_found");
    expect(["active", "rejected"]).toContain(
      (await prismaClient.client.findUnique({ where: { id: clientId } }))?.status,
    );
    expect(await clientTokenRepository.findById(tokenId)).toBeNull();
  });
});
