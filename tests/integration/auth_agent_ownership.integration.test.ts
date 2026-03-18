import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";

const app = createApp();

describe("Agent login ownership", () => {
  it("should block a second user from claiming an already bound agentId", async () => {
    const sharedAgentId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const emailA = `owner-a-${Date.now()}@test.com`;
    const emailB = `owner-b-${Date.now()}@test.com`;
    const password = "Ownership1";

    const registerA = await request(app).post("/api/v1/auth/register").send({
      email: emailA,
      password,
    });
    expect(registerA.status).toBe(201);

    const registerB = await request(app).post("/api/v1/auth/register").send({
      email: emailB,
      password,
    });
    expect(registerB.status).toBe(201);

    const firstLogin = await request(app).post("/api/v1/auth/agent-login").send({
      email: emailA,
      password,
      agentId: sharedAgentId,
    });
    expect(firstLogin.status).toBe(200);

    const secondLogin = await request(app).post("/api/v1/auth/agent-login").send({
      email: emailB,
      password,
      agentId: sharedAgentId,
    });
    expect(secondLogin.status).toBe(403);
    expect(secondLogin.body.code).toBe("FORBIDDEN");

    const sameOwnerLogin = await request(app).post("/api/v1/auth/agent-login").send({
      email: emailA,
      password,
      agentId: sharedAgentId,
    });
    expect(sameOwnerLogin.status).toBe(200);
  });
});
