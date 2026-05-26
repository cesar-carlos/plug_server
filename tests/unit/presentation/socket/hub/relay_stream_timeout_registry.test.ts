import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  registerRelayStreamTimeouts,
  resetRelayStreamTimeouts,
  touchRelayStreamTimeout,
} from "../../../../../src/presentation/socket/hub/registries/relay_stream_timeout_registry";

describe("relay_stream_timeout_registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRelayStreamTimeouts();
  });

  afterEach(() => {
    resetRelayStreamTimeouts();
    vi.useRealTimers();
  });

  it("fires idle timeout when a stream is not touched", async () => {
    const onTimeout = vi.fn();
    registerRelayStreamTimeouts("req-idle", onTimeout);

    await vi.advanceTimersByTimeAsync(env.socketRelayStreamIdleTimeoutMs + 1);

    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("fires lifetime timeout even when idle is refreshed", async () => {
    const onTimeout = vi.fn();
    registerRelayStreamTimeouts("req-lifetime", onTimeout);

    let elapsed = 0;
    while (elapsed + 25_000 < env.socketRelayStreamMaxLifetimeMs) {
      await vi.advanceTimersByTimeAsync(25_000);
      elapsed += 25_000;
      touchRelayStreamTimeout("req-lifetime");
    }

    await vi.advanceTimersByTimeAsync(env.socketRelayStreamMaxLifetimeMs - elapsed + 1);

    expect(onTimeout).toHaveBeenCalledWith("lifetime");
  });
});
