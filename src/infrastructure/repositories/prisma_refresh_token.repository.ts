import type { RefreshToken as PrismaRefreshToken } from "@prisma/client";

import { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
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
