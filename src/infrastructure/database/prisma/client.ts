import { PrismaClient } from "@prisma/client";

declare global {
  var prismaClientSingleton: PrismaClient | undefined;
}

const createPrismaClient = (): PrismaClient => {
  return new PrismaClient({
    log: ["warn", "error"],
  });
};

export const prismaClient = globalThis.prismaClientSingleton ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaClientSingleton = prismaClient;
}
