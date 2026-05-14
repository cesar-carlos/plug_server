/**
 * Lightweight counters for transient Prisma transaction retries.
 * Exposed via GET /metrics.
 */

let retryAttemptsTotal = 0;
let retriesExhaustedTotal = 0;

const retryAttemptsByOperation = new Map<string, number>();
const retriesExhaustedByOperation = new Map<string, number>();

export const notePrismaTransactionRetryAttempt = (operation: string): void => {
  retryAttemptsTotal += 1;
  retryAttemptsByOperation.set(operation, (retryAttemptsByOperation.get(operation) ?? 0) + 1);
};

export const notePrismaTransactionRetryExhausted = (operation: string): void => {
  retriesExhaustedTotal += 1;
  retriesExhaustedByOperation.set(operation, (retriesExhaustedByOperation.get(operation) ?? 0) + 1);
};

export const getPrismaTransactionRetryMetricsSnapshot = (): {
  readonly retryAttemptsTotal: number;
  readonly retriesExhaustedTotal: number;
  readonly retryAttemptsByOperation: ReadonlyMap<string, number>;
  readonly retriesExhaustedByOperation: ReadonlyMap<string, number>;
} => ({
  retryAttemptsTotal,
  retriesExhaustedTotal,
  retryAttemptsByOperation: new Map(retryAttemptsByOperation),
  retriesExhaustedByOperation: new Map(retriesExhaustedByOperation),
});

export const resetPrismaTransactionRetryMetricsForTests = (): void => {
  retryAttemptsTotal = 0;
  retriesExhaustedTotal = 0;
  retryAttemptsByOperation.clear();
  retriesExhaustedByOperation.clear();
};
