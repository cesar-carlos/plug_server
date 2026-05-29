/**
 * Shared local circuit breaker for Redis-backed modules. Both the socket and
 * REST rate-limit modules previously kept an identical copy of this logic
 * (`redisCommandFailures` / `circuitOpenUntilMs` + record success/failure).
 *
 * Behaviour:
 *   - `recordFailure` increments the failure counter and, once it reaches the
 *     threshold, opens the circuit for `openMs` and resets the counter.
 *   - `recordSuccess` clears the counter and closes an open circuit.
 *   - `isOpen` reports whether the circuit is currently open (callers fail-open
 *     to their in-memory limiter while open).
 *
 * Thresholds are read lazily via getters so env overrides applied after import
 * (and partial test env mocks) are honoured; non-finite/negative values fall
 * back to the historical defaults (3 failures / 5s) so behaviour never silently
 * changes when an env field is absent.
 */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_OPEN_MS = 5_000;

export interface RedisCircuitBreakerCallbacks {
  /** Fired on every recorded failure (before the open transition is decided). */
  readonly onCommandError?: () => void;
  /** Fired when the failure counter reaches the threshold and the circuit opens. */
  readonly onOpened?: (error: unknown) => void;
  /** Fired when a success closes a previously open circuit. */
  readonly onClosed?: () => void;
  /** Fired on every recorded success (after any close transition). */
  readonly onRecovered?: () => void;
}

export interface RedisCircuitBreakerConfig {
  readonly getFailureThreshold: () => number;
  readonly getOpenMs: () => number;
  readonly callbacks?: RedisCircuitBreakerCallbacks;
}

export interface RedisCircuitBreaker {
  /** `true` while the circuit is open (within the open window). */
  isOpen(): boolean;
  /** Clears the failure counter and closes an open circuit. */
  recordSuccess(): void;
  /** Increments the failure counter; opens the circuit at the threshold. */
  recordFailure(error: unknown): void;
  /** Resets all state to closed/zero (boot/close/reconnect). */
  reset(): void;
}

export const createRedisCircuitBreaker = (
  config: RedisCircuitBreakerConfig,
): RedisCircuitBreaker => {
  let failures = 0;
  let openUntilMs = 0;

  const failureThreshold = (): number => {
    const value = config.getFailureThreshold();
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FAILURE_THRESHOLD;
  };
  const openMs = (): number => {
    const value = config.getOpenMs();
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_OPEN_MS;
  };

  return {
    isOpen: (): boolean => Date.now() < openUntilMs,
    recordFailure: (error: unknown): void => {
      failures += 1;
      config.callbacks?.onCommandError?.();
      const threshold = failureThreshold();
      if (threshold > 0 && failures >= threshold) {
        openUntilMs = Date.now() + openMs();
        failures = 0;
        config.callbacks?.onOpened?.(error);
      }
    },
    recordSuccess: (): void => {
      failures = 0;
      if (openUntilMs !== 0) {
        openUntilMs = 0;
        config.callbacks?.onClosed?.();
      }
      config.callbacks?.onRecovered?.();
    },
    reset: (): void => {
      failures = 0;
      openUntilMs = 0;
    },
  };
};
