import {
  Prisma,
  type Client as PrismaClientModel,
  type ClientStatus as PrismaClientStatus,
} from "@prisma/client";

import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import { conflict } from "../../shared/errors/http_errors";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientRepository implements IClientRepository {
  async findById(id: string): Promise<Client | null> {
    const client = await prismaClient.client.findUnique({ where: { id } });
    return client ? this.toDomain(client) : null;
  }

  async findByEmail(email: string): Promise<Client | null> {
    const client = await prismaClient.client.findUnique({ where: { email } });
    return client ? this.toDomain(client) : null;
  }

  async listByUserId(userId: string): Promise<Client[]> {
    const clients = await prismaClient.client.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return clients.map((item) => this.toDomain(item));
  }

  async save(client: Client): Promise<void> {
    try {
      await prismaClient.client.upsert({
        where: { id: client.id },
        create: {
          id: client.id,
          userId: client.userId,
          email: client.email,
          passwordHash: client.passwordHash,
          name: client.name,
          lastName: client.lastName,
          mobile: client.mobile ?? null,
          thumbnailUrl: client.thumbnailUrl ?? null,
          credentialsUpdatedAt: client.credentialsUpdatedAt,
          status: client.status as PrismaClientStatus,
          createdAt: client.createdAt,
          updatedAt: client.updatedAt,
        },
        update: {
          userId: client.userId,
          email: client.email,
          passwordHash: client.passwordHash,
          name: client.name,
          lastName: client.lastName,
          mobile: client.mobile ?? null,
          thumbnailUrl: client.thumbnailUrl ?? null,
          credentialsUpdatedAt: client.credentialsUpdatedAt,
          status: client.status as PrismaClientStatus,
          updatedAt: client.updatedAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw conflict("Client email already in use");
      }
      throw error;
    }
  }

  async deleteById(id: string): Promise<void> {
    await prismaClient.client.deleteMany({ where: { id } });
  }

  private toDomain(client: PrismaClientModel): Client {
    return new Client({
      id: client.id,
      userId: client.userId,
      email: client.email,
      passwordHash: client.passwordHash,
      name: client.name,
      lastName: client.lastName,
      ...(client.mobile != null && client.mobile !== "" ? { mobile: client.mobile } : {}),
      ...(client.thumbnailUrl != null && client.thumbnailUrl !== ""
        ? { thumbnailUrl: client.thumbnailUrl }
        : {}),
      credentialsUpdatedAt: client.credentialsUpdatedAt,
      status: client.status as ClientStatus,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    });
  }
}
