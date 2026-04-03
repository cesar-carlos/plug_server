import type { ClientPasswordRecoveryToken as PrismaToken } from "@prisma/client";

import type {
  ClientPasswordRecoveryToken,
  IClientPasswordRecoveryTokenRepository,
} from "../../domain/repositories/client_password_recovery_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientPasswordRecoveryTokenRepository
  implements IClientPasswordRecoveryTokenRepository
{
  async save(token: ClientPasswordRecoveryToken): Promise<void> {
    const hashedId = hashRegistrationToken(token.id);
    await prismaClient.clientPasswordRecoveryToken.upsert({
      where: { clientId: token.clientId },
      create: {
        id: hashedId,
        clientId: token.clientId,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
      },
      update: {
        id: hashedId,
        expiresAt: token.expiresAt,
      },
    });
  }

  async findById(id: string): Promise<ClientPasswordRecoveryToken | null> {
    const hashedId = hashRegistrationToken(id);
    const row =
      (await prismaClient.clientPasswordRecoveryToken.findUnique({
        where: { id: hashedId },
      })) ??
      (await prismaClient.clientPasswordRecoveryToken.findUnique({
        where: { id },
      }));
    return row ? this.toDomain(row) : null;
  }

  async deleteById(id: string): Promise<void> {
    const hashedId = hashRegistrationToken(id);
    await prismaClient.clientPasswordRecoveryToken.deleteMany({
      where: {
        OR: [{ id: hashedId }, { id }],
      },
    });
  }

  async deleteByClientId(clientId: string): Promise<void> {
    await prismaClient.clientPasswordRecoveryToken.deleteMany({
      where: { clientId },
    });
  }

  private toDomain(row: PrismaToken): ClientPasswordRecoveryToken {
    return {
      id: row.id,
      clientId: row.clientId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}
