import {
  Prisma,
  type User as PrismaUser,
  type UserStatus as PrismaUserStatus,
} from "@prisma/client";

import { User, type UserStatus } from "../../domain/entities/user.entity";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import { conflict } from "../../shared/errors/http_errors";
import { prismaClient } from "../database/prisma/client";

export class PrismaUserRepository implements IUserRepository {
  async findById(id: string): Promise<User | null> {
    const user = await prismaClient.user.findUnique({
      where: { id },
    });

    if (!user) {
      return null;
    }

    return this.toDomain(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    const user = await prismaClient.user.findUnique({
      where: { email },
    });

    if (!user) {
      return null;
    }

    return this.toDomain(user);
  }

  async save(user: User): Promise<void> {
    try {
      await prismaClient.user.upsert({
        where: { id: user.id },
        create: {
          id: user.id,
          email: user.email,
          passwordHash: user.passwordHash,
          role: user.role,
          status: user.status as PrismaUserStatus,
          createdAt: user.createdAt,
        },
        update: {
          email: user.email,
          passwordHash: user.passwordHash,
          role: user.role,
          status: user.status as PrismaUserStatus,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw conflict("Email already in use");
      }
      throw error;
    }
  }

  private toDomain(user: PrismaUser): User {
    return new User({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      role: user.role,
      status: user.status as UserStatus,
      createdAt: user.createdAt,
    });
  }
}
