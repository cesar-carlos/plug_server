import type { RefreshToken as PrismaRefreshToken } from "@prisma/client";

import { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type {
  ConsumeRefreshTokenStatus,
  IRefreshTokenRepository,
} from "../../domain/repositories/refresh_token.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaRefreshTokenRepository implements IRefreshTokenRepository {
  async findById(id: string): Promise<RefreshToken | null> {
    const token = await prismaClient.refreshToken.findUnique({
      where: { id },
    });

    if (!token) {
      return null;
    }

    return this.toDomain(token);
  }

  async save(token: RefreshToken): Promise<void> {
    const createInput = {
      id: token.id,
      userId: token.userId,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
    };

    const updateInput = {
      userId: token.userId,
      expiresAt: token.expiresAt,
      ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
    };

    await prismaClient.refreshToken.upsert({
      where: { id: token.id },
      create: createInput,
      update: updateInput,
    });
  }

  async revoke(id: string): Promise<void> {
    await prismaClient.refreshToken.updateMany({
      where: {
        id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const now = new Date();
    await prismaClient.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
  }

  async consume(id: string, userId: string, now: Date): Promise<ConsumeRefreshTokenStatus> {
    const consumeResult = await prismaClient.refreshToken.updateMany({
      where: {
        id,
        userId,
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        revokedAt: now,
      },
    });

    if (consumeResult.count === 1) {
      return "consumed";
    }

    const token = await prismaClient.refreshToken.findUnique({
      where: { id },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (!token) {
      return "not_found";
    }

    if (token.userId !== userId) {
      return "user_mismatch";
    }

    if (token.revokedAt !== null) {
      return "revoked";
    }

    if (token.expiresAt <= now) {
      return "expired";
    }

    return "revoked";
  }

  private toDomain(token: PrismaRefreshToken): RefreshToken {
    const props = {
      id: token.id,
      userId: token.userId,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
    };

    return new RefreshToken({
      ...props,
    });
  }
}
