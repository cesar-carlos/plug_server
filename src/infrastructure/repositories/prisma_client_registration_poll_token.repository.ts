import type { ClientRegistrationPollToken as PrismaToken } from "@prisma/client";

import type {
  ClientRegistrationPollToken,
  IClientRegistrationPollTokenRepository,
} from "../../domain/repositories/client_registration_poll_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientRegistrationPollTokenRepository implements IClientRegistrationPollTokenRepository {
  async save(token: ClientRegistrationPollToken): Promise<void> {
    const hashedId = hashRegistrationToken(token.id);
    await prismaClient.clientRegistrationPollToken.upsert({
      where: { clientId: token.clientId },
      create: {
        id: hashedId,
        clientId: token.clientId,
        createdAt: token.createdAt,
      },
      update: {
        id: hashedId,
      },
    });
  }

  async findById(id: string): Promise<ClientRegistrationPollToken | null> {
    const hashedId = hashRegistrationToken(id);
    const row = await prismaClient.clientRegistrationPollToken.findFirst({
      where: { OR: [{ id: hashedId }, { id }] },
    });
    return row ? this.toDomain(row) : null;
  }

  async findByClientId(clientId: string): Promise<ClientRegistrationPollToken | null> {
    const row = await prismaClient.clientRegistrationPollToken.findUnique({
      where: { clientId },
    });
    return row ? this.toDomain(row) : null;
  }

  async deleteByClientId(clientId: string): Promise<void> {
    await prismaClient.clientRegistrationPollToken.deleteMany({ where: { clientId } });
  }

  private toDomain(row: PrismaToken): ClientRegistrationPollToken {
    return {
      id: row.id,
      clientId: row.clientId,
      createdAt: row.createdAt,
    };
  }
}
