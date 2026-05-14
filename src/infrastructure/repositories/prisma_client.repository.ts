import {
  Prisma,
  type Client as PrismaClientModel,
  type ClientStatus as PrismaClientStatus,
} from "@prisma/client";

import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import type {
  ClientActiveSnapshot,
  IClientRepository,
} from "../../domain/repositories/client.repository.interface";
import { conflict } from "../../shared/errors/http_errors";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientRepository implements IClientRepository {
  async findById(id: string): Promise<Client | null> {
    const client = await prismaClient.client.findUnique({ where: { id } });
    return client ? this.toDomain(client) : null;
  }

  /**
   * Hot-path projection: only the columns the active-account check needs.
   * Avoids fetching `password_hash`, profile/address blobs, and timestamps for
   * every socket event.
   */
  async findActiveSnapshotById(id: string): Promise<ClientActiveSnapshot | null> {
    const row = await prismaClient.client.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        credentialsUpdatedAt: true,
      },
    });

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      status: row.status as ClientStatus,
      credentialsUpdatedAt: row.credentialsUpdatedAt,
    };
  }

  async findByEmail(email: string): Promise<Client | null> {
    const normalized = email.trim();
    if (normalized === "") {
      return null;
    }

    const client = await prismaClient.client.findUnique({
      where: { email: normalized },
    });
    return client ? this.toDomain(client) : null;
  }

  async listByUserId(userId: string): Promise<Client[]> {
    const clients = await prismaClient.client.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return clients.map((item) => this.toDomain(item));
  }

  async findActiveIdsByIds(ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return [];
    }
    const rows = await prismaClient.client.findMany({
      where: { id: { in: unique }, status: "active" },
      select: { id: true },
    });
    const active = new Set(rows.map((row) => row.id));
    return unique.filter((id) => active.has(id));
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
