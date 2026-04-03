import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientRefreshToken } from "../../../../src/domain/entities/client_refresh_token.entity";
import { RefreshToken } from "../../../../src/domain/entities/refresh_token.entity";
import { prismaClient } from "../../../../src/infrastructure/database/prisma/client";
import { PrismaClientRefreshTokenRepository } from "../../../../src/infrastructure/repositories/prisma_client_refresh_token.repository";
import { PrismaRefreshTokenRepository } from "../../../../src/infrastructure/repositories/prisma_refresh_token.repository";

describe("Prisma token repositories", () => {
  const refreshTokenRepository = new PrismaRefreshTokenRepository();
  const clientRefreshTokenRepository = new PrismaClientRefreshTokenRepository();

  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();
  const createdRefreshTokenIds = new Set<string>();
  const createdClientRefreshTokenIds = new Set<string>();

  const uniqueSuffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const createUser = async () => {
    const suffix = uniqueSuffix();
    const user = await prismaClient.user.create({
      data: {
        email: `repo-user-${suffix}@test.com`,
        passwordHash: "hash",
        role: "user",
        status: "active",
      },
    });
    createdUserIds.add(user.id);
    return user;
  };

  const createClient = async (userId: string) => {
    const suffix = uniqueSuffix();
    const client = await prismaClient.client.create({
      data: {
        userId,
        email: `repo-client-${suffix}@test.com`,
        passwordHash: "hash",
        name: "Client",
        lastName: "Repo",
        status: "active",
      },
    });
    createdClientIds.add(client.id);
    return client;
  };

  beforeEach(() => {
    createdUserIds.clear();
    createdClientIds.clear();
    createdRefreshTokenIds.clear();
    createdClientRefreshTokenIds.clear();
  });

  afterEach(async () => {
    if (createdClientRefreshTokenIds.size > 0) {
      await prismaClient.clientRefreshToken.deleteMany({
        where: { id: { in: Array.from(createdClientRefreshTokenIds) } },
      });
    }
    if (createdRefreshTokenIds.size > 0) {
      await prismaClient.refreshToken.deleteMany({
        where: { id: { in: Array.from(createdRefreshTokenIds) } },
      });
    }
    if (createdClientIds.size > 0) {
      await prismaClient.client.deleteMany({
        where: { id: { in: Array.from(createdClientIds) } },
      });
    }
    if (createdUserIds.size > 0) {
      await prismaClient.user.deleteMany({
        where: { id: { in: Array.from(createdUserIds) } },
      });
    }
  });

  it("persists, loads, and consumes a user refresh token", async () => {
    const user = await createUser();
    const tokenId = `user-refresh-${uniqueSuffix()}`;
    createdRefreshTokenIds.add(tokenId);

    const token = RefreshToken.create({
      id: tokenId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 5_000),
    });

    await refreshTokenRepository.save(token);

    await expect(refreshTokenRepository.findById(tokenId)).resolves.toMatchObject({
      id: tokenId,
      userId: user.id,
      revokedAt: undefined,
    });

    await expect(
      refreshTokenRepository.consume(tokenId, user.id, new Date(Date.now() + 1_000)),
    ).resolves.toBe("consumed");

    const stored = await prismaClient.refreshToken.findUnique({ where: { id: tokenId } });
    expect(stored?.revokedAt).not.toBeNull();
  });

  it("reports all non-success consume statuses for user refresh tokens", async () => {
    const user = await createUser();
    const otherUser = await createUser();

    const revokedId = `user-revoked-${uniqueSuffix()}`;
    const expiredId = `user-expired-${uniqueSuffix()}`;
    const mismatchId = `user-mismatch-${uniqueSuffix()}`;
    createdRefreshTokenIds.add(revokedId);
    createdRefreshTokenIds.add(expiredId);
    createdRefreshTokenIds.add(mismatchId);

    await refreshTokenRepository.save(
      new RefreshToken({
        id: revokedId,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );
    await refreshTokenRepository.save(
      RefreshToken.create({
        id: expiredId,
        userId: user.id,
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );
    await refreshTokenRepository.save(
      RefreshToken.create({
        id: mismatchId,
        userId: otherUser.id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );

    const now = new Date();

    await expect(refreshTokenRepository.consume("missing-token", user.id, now)).resolves.toBe(
      "not_found",
    );
    await expect(refreshTokenRepository.consume(revokedId, user.id, now)).resolves.toBe("revoked");
    await expect(refreshTokenRepository.consume(expiredId, user.id, now)).resolves.toBe("expired");
    await expect(refreshTokenRepository.consume(mismatchId, user.id, now)).resolves.toBe(
      "user_mismatch",
    );
  });

  it("revokes only active user refresh tokens for the target user", async () => {
    const user = await createUser();
    const otherUser = await createUser();

    const activeId = `user-active-${uniqueSuffix()}`;
    const alreadyRevokedId = `user-already-revoked-${uniqueSuffix()}`;
    const otherUserId = `other-user-active-${uniqueSuffix()}`;
    createdRefreshTokenIds.add(activeId);
    createdRefreshTokenIds.add(alreadyRevokedId);
    createdRefreshTokenIds.add(otherUserId);

    await refreshTokenRepository.save(
      RefreshToken.create({
        id: activeId,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await refreshTokenRepository.save(
      new RefreshToken({
        id: alreadyRevokedId,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 5_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );
    await refreshTokenRepository.save(
      RefreshToken.create({
        id: otherUserId,
        userId: otherUser.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    await refreshTokenRepository.revokeAllForUser(user.id);

    const [active, alreadyRevoked, other] = await Promise.all([
      prismaClient.refreshToken.findUnique({ where: { id: activeId } }),
      prismaClient.refreshToken.findUnique({ where: { id: alreadyRevokedId } }),
      prismaClient.refreshToken.findUnique({ where: { id: otherUserId } }),
    ]);

    expect(active?.revokedAt).not.toBeNull();
    expect(alreadyRevoked?.revokedAt).not.toBeNull();
    expect(other?.revokedAt).toBeNull();
  });

  it("persists, loads, and consumes a client refresh token", async () => {
    const owner = await createUser();
    const client = await createClient(owner.id);
    const tokenId = `client-refresh-${uniqueSuffix()}`;
    createdClientRefreshTokenIds.add(tokenId);

    const token = ClientRefreshToken.create({
      id: tokenId,
      clientId: client.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 5_000),
    });

    await clientRefreshTokenRepository.save(token);

    await expect(clientRefreshTokenRepository.findById(tokenId)).resolves.toMatchObject({
      id: tokenId,
      clientId: client.id,
      revokedAt: undefined,
    });

    await expect(
      clientRefreshTokenRepository.consume(tokenId, client.id, new Date(Date.now() + 1_000)),
    ).resolves.toBe("consumed");

    const stored = await prismaClient.clientRefreshToken.findUnique({ where: { id: tokenId } });
    expect(stored?.revokedAt).not.toBeNull();
  });

  it("reports all non-success consume statuses for client refresh tokens", async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const client = await createClient(owner.id);
    const otherClient = await createClient(otherOwner.id);

    const revokedId = `client-revoked-${uniqueSuffix()}`;
    const expiredId = `client-expired-${uniqueSuffix()}`;
    const mismatchId = `client-mismatch-${uniqueSuffix()}`;
    createdClientRefreshTokenIds.add(revokedId);
    createdClientRefreshTokenIds.add(expiredId);
    createdClientRefreshTokenIds.add(mismatchId);

    await clientRefreshTokenRepository.save(
      new ClientRefreshToken({
        id: revokedId,
        clientId: client.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );
    await clientRefreshTokenRepository.save(
      ClientRefreshToken.create({
        id: expiredId,
        clientId: client.id,
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );
    await clientRefreshTokenRepository.save(
      ClientRefreshToken.create({
        id: mismatchId,
        clientId: otherClient.id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );

    const now = new Date();

    await expect(clientRefreshTokenRepository.consume("missing-token", client.id, now)).resolves.toBe(
      "not_found",
    );
    await expect(clientRefreshTokenRepository.consume(revokedId, client.id, now)).resolves.toBe(
      "revoked",
    );
    await expect(clientRefreshTokenRepository.consume(expiredId, client.id, now)).resolves.toBe(
      "expired",
    );
    await expect(clientRefreshTokenRepository.consume(mismatchId, client.id, now)).resolves.toBe(
      "client_mismatch",
    );
  });

  it("revokes only active client refresh tokens for the target client", async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const client = await createClient(owner.id);
    const otherClient = await createClient(otherOwner.id);

    const activeId = `client-active-${uniqueSuffix()}`;
    const alreadyRevokedId = `client-already-revoked-${uniqueSuffix()}`;
    const otherClientId = `other-client-active-${uniqueSuffix()}`;
    createdClientRefreshTokenIds.add(activeId);
    createdClientRefreshTokenIds.add(alreadyRevokedId);
    createdClientRefreshTokenIds.add(otherClientId);

    await clientRefreshTokenRepository.save(
      ClientRefreshToken.create({
        id: activeId,
        clientId: client.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await clientRefreshTokenRepository.save(
      new ClientRefreshToken({
        id: alreadyRevokedId,
        clientId: client.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 5_000),
        createdAt: new Date(Date.now() - 10_000),
      }),
    );
    await clientRefreshTokenRepository.save(
      ClientRefreshToken.create({
        id: otherClientId,
        clientId: otherClient.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    await clientRefreshTokenRepository.revokeAllForClient(client.id);

    const [active, alreadyRevoked, other] = await Promise.all([
      prismaClient.clientRefreshToken.findUnique({ where: { id: activeId } }),
      prismaClient.clientRefreshToken.findUnique({ where: { id: alreadyRevokedId } }),
      prismaClient.clientRefreshToken.findUnique({ where: { id: otherClientId } }),
    ]);

    expect(active?.revokedAt).not.toBeNull();
    expect(alreadyRevoked?.revokedAt).not.toBeNull();
    expect(other?.revokedAt).toBeNull();
  });
});
