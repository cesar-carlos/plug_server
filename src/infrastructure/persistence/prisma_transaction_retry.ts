import { Prisma } from "@prisma/client";

import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

const transientPostgresCodes = new Set(["40001", "40P01"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const findPostgresCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (isRecord(current)) {
      const code = current.code;
      if (typeof code === "string" && transientPostgresCodes.has(code)) {
        return code;
      }
      const cause = current.cause;
      if (cause !== undefined) {
        current = cause;
        continue;
      }
    }
    break;
  }
  return undefined;
};

export const isPrismaTransientTransactionError = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return true;
  }
  return findPostgresCode(error) !== undefined;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const runPrismaTransactionWithRetry = async <T>(
  operation: string,
  work: () => Promise<T>,
): Promise<T> => {
  const maxAttempts = env.databaseTransactionRetryMaxAttempts;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await work();
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxAttempts || !isPrismaTransientTransactionError(error)) {
        throw error;
      }
      const baseDelayMs = env.databaseTransactionRetryBaseDelayMs;
      const delayMs =
        baseDelayMs === 0
          ? 0
          : Math.min(1_000, baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 10));
      logger.warn("prisma_transaction_retry", {
        operation,
        attempt,
        maxAttempts,
        delayMs,
        message: error instanceof Error ? error.message : String(error),
      });
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
};
