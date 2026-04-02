import type { ClientRefreshToken as PrismaClientRefreshToken } from "@prisma/client";

import { ClientRefreshToken } from "../../domain/entities/client_refresh_token.entity";
import type {
  ConsumeClientRefreshTokenStatus,
  IClientRefreshTokenRepository,
} from "../../domain/repositories/client_refresh_token.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientRefreshTokenRepository implements IClientRefreshTokenRepository {
  async findById(id: string): Promise<ClientRefreshToken | null> {
    const token = await prismaClient.clientRefreshToken.findUnique({ where: { id } });
    return token ? this.toDomain(token) : null;
  }

  async save(token: ClientRefreshToken): Promise<void> {
    await prismaClient.clientRefreshToken.upsert({
      where: { id: token.id },
      create: {
        id: token.id,
        clientId: token.clientId,
        expiresAt: token.expiresAt,
        ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
        createdAt: token.createdAt,
      },
      update: {
        clientId: token.clientId,
        expiresAt: token.expiresAt,
        ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
      },
    });
  }

  async revoke(id: string): Promise<void> {
    await prismaClient.clientRefreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForClient(clientId: string): Promise<void> {
    await prismaClient.clientRefreshToken.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async consume(id: string, clientId: string, now: Date): Promise<ConsumeClientRefreshTokenStatus> {
    const updated = await prismaClient.clientRefreshToken.updateMany({
      where: {
        id,
        clientId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    if (updated.count === 1) {
      return "consumed";
    }

    const token = await prismaClient.clientRefreshToken.findUnique({
      where: { id },
      select: { clientId: true, revokedAt: true, expiresAt: true },
    });
    if (!token) {
      return "not_found";
    }
    if (token.clientId !== clientId) {
      return "client_mismatch";
    }
    if (token.revokedAt !== null) {
      return "revoked";
    }
    if (token.expiresAt <= now) {
      return "expired";
    }
    return "revoked";
  }

  private toDomain(token: PrismaClientRefreshToken): ClientRefreshToken {
    return new ClientRefreshToken({
      id: token.id,
      clientId: token.clientId,
      expiresAt: token.expiresAt,
      ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
      createdAt: token.createdAt,
    });
  }
}
