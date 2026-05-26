import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { logger } from "../../../shared/utils/logger";

declare global {
  var prismaClientSingleton: PrismaClient | undefined;
}

/**
 * Resolves the Prisma log levels to emit as **events** (not stdout). Production
 * stays narrow to avoid noise from slow-query warnings on transient spikes;
 * non-production includes `warn` so developers see actionable hints during
 * local work.
 */
const resolveLogDefinitions = (): Prisma.LogDefinition[] => {
  if (process.env.NODE_ENV === "production") {
    return [{ level: "error", emit: "event" }];
  }
  return [
    { level: "warn", emit: "event" },
    { level: "error", emit: "event" },
  ];
};

const createPrismaClient = (): PrismaClient => {
  /**
   * Cast is needed because `PrismaClient`'s generic log type is computed from
   * the literal `log` array supplied at construction time; passing an
   * `LogDefinition[]` whose contents are dynamic resolves to a union the
   * `$on` overload cannot narrow. The runtime contract is unchanged.
   */
  const client = new PrismaClient({
    log: resolveLogDefinitions(),
  });
  client.$on("warn" as never, (event: Prisma.LogEvent) => {
    logger.warn("prisma_warn", {
      message: event.message,
      target: event.target,
    });
  });
  client.$on("error" as never, (event: Prisma.LogEvent) => {
    logger.error("prisma_error", {
      message: event.message,
      target: event.target,
    });
  });
  return client;
};

export const prismaClient = globalThis.prismaClientSingleton ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaClientSingleton = prismaClient;
}
