export type RetryOptions = {
  readonly maxAttempts: number;
  /**
   * Delay between attempts in ms. Pass `0` to skip delay.
   * When `exponential` is true this is used as the base and capped at `maxDelayMs`.
   */
  readonly delayMs: number;
  /** When true each retry waits `delayMs * 2^(attempt-1)` capped at `maxDelayMs`. Default false (linear). */
  readonly exponential?: boolean;
  readonly maxDelayMs?: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `action` up to `maxAttempts` times.
 * Throws with the last error message when all attempts fail.
 */
export const withRetry = async <T>(
  operation: string,
  action: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> => {
  const { maxAttempts, delayMs, exponential = false, maxDelayMs = 30_000 } = opts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && delayMs > 0) {
        const wait = exponential
          ? Math.min(delayMs * Math.pow(2, attempt - 1), maxDelayMs)
          : delayMs;
        await sleep(wait);
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${operation} failed after ${maxAttempts} attempts: ${msg}`);
};
