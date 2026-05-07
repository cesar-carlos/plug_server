import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetAgentRegisterRateLimitState,
  tryConsumeAgentRegisterRateLimit,
} from "../../../../../src/presentation/socket/hub/agent_register_rate_limit";

describe("agent_register_rate_limit", () => {
  afterEach(() => {
    resetAgentRegisterRateLimitState();
  });

  it("allows bursts within max inside the window", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(
        tryConsumeAgentRegisterRateLimit("u1", "a1", { windowMs: 60_000, max: 3 }),
      ).toEqual({ ok: true });
    }
    expect(
      tryConsumeAgentRegisterRateLimit("u1", "a1", { windowMs: 60_000, max: 3 }),
    ).toEqual({ ok: false });
  });

  it("prunes stale timestamps on reject so expired slots free capacity", () => {
    const windowMs = 1000;
    const max = 2;
    expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: true });
    expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: true });
    expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: false });

    const later = Date.now() + windowMs + 50;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("drops bucket entry when all stamps expired before next consume", () => {
    const windowMs = 50;
    expect(
      tryConsumeAgentRegisterRateLimit("ux", "ax", { windowMs, max: 5 }),
    ).toEqual({ ok: true });

    const later = Date.now() + windowMs + 10;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(
        tryConsumeAgentRegisterRateLimit("ux", "ax", { windowMs, max: 5 }),
      ).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });
});
