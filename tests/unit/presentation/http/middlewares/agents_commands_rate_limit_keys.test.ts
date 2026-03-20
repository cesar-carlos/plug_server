import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import {
  agentsCommandsIpRateLimitKey,
  agentsCommandsUserRateLimitKey,
} from "../../../../../src/presentation/http/middlewares/rate_limit.middleware";

describe("agentsCommands rate limit keys", () => {
  it("agentsCommandsIpRateLimitKey uses req.ip", () => {
    const req = { ip: "203.0.113.10" } as Request;
    expect(agentsCommandsIpRateLimitKey(req)).toBe("agents_commands:ip:203.0.113.10");
  });

  it("agentsCommandsUserRateLimitKey uses JWT sub from response.locals", () => {
    const res = { locals: { authUser: { sub: "user-uuid-1" } } } as unknown as Response;
    expect(agentsCommandsUserRateLimitKey(res)).toBe("agents_commands:user:user-uuid-1");
  });

  it("agentsCommandsUserRateLimitKey falls back when sub missing", () => {
    const res = { locals: {} } as unknown as Response;
    expect(agentsCommandsUserRateLimitKey(res)).toBe("agents_commands:user:anonymous");
  });
});
