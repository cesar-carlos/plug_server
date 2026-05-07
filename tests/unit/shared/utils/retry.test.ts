import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../../../../src/shared/utils/retry";

describe("withRetry", () => {
  it("returns value on first success", async () => {
    const action = vi.fn().mockResolvedValue(42);
    const result = await withRetry("op", action, { maxAttempts: 3, delayMs: 0 });
    expect(result).toBe(42);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on second attempt", async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");
    const result = await withRetry("op", action, { maxAttempts: 3, delayMs: 0 });
    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("throws after all attempts fail", async () => {
    const action = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry("op", action, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow(
      "op failed after 3 attempts: always fails",
    );
    expect(action).toHaveBeenCalledTimes(3);
  });

  it("applies exponential backoff between attempts", async () => {
    vi.useFakeTimers();
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("done");

    const promise = withRetry("op", action, {
      maxAttempts: 3,
      delayMs: 100,
      exponential: true,
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("done");
    expect(action).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("respects maxDelayMs cap", async () => {
    vi.useFakeTimers();
    const action = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("done");

    const promise = withRetry("op", action, {
      maxAttempts: 2,
      delayMs: 99_999,
      exponential: true,
      maxDelayMs: 500,
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("done");
    vi.useRealTimers();
  });
});
