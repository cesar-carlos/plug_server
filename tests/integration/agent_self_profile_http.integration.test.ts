import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer, type TestServerResult } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent } from "./helpers/seed_agent";
import { env } from "../../src/shared/config/env";
import { getTestRepositoryAccess } from "../../src/shared/di/container";

const repositories = getTestRepositoryAccess();

const registerApprovedUser = async (
  baseUrl: string,
  suffix: string,
): Promise<{ email: string; password: string; accessToken: string; userId: string }> => {
  const email = `agent-self-http-${suffix}-${Date.now()}@test.com`;
  const password = "AgentSelfHttp1";

  const registerResponse = await request(baseUrl).post("/api/v1/auth/register").send({
    email,
    password,
  });
  expect(registerResponse.status).toBe(201);
  await approveRegistrationByToken(baseUrl, registerResponse.body.approvalToken as string);

  const loginResponse = await request(baseUrl).post("/api/v1/auth/login").send({
    email,
    password,
  });
  expect(loginResponse.status).toBe(200);

  return {
    email,
    password,
    accessToken: loginResponse.body.accessToken as string,
    userId: registerResponse.body.user.id as string,
  };
};

describe("Agent self profile HTTP route", () => {
  let server: TestServerResult;
  let baseUrl = "";

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();
  });

  afterAll(async () => {
    await server.close();
  });

  it("PATCH /api/v1/agents/:agentId/profile should create or update the authenticated agent snapshot without socket connection", async () => {
    const user = await registerApprovedUser(baseUrl, "create");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const response = await request(baseUrl)
      .patch(`/api/v1/agents/${agentId}/profile`)
      .set("Authorization", `Bearer ${agentLoginResponse.body.accessToken as string}`)
      .send({
        name: "HTTP Self Agent",
        tradeName: "HTTP Trade",
        document: "59261947000107",
        documentType: "cnpj",
        mobile: "65992865050",
        email: "http-self@test.local",
        address: {
          street: "Avenida Brasil",
          number: "130",
          district: "Centro",
          postalCode: "78300096",
          city: "Tangara da Serra",
          state: "MT",
        },
        notes: "Created offline via HTTP",
      });

    expect(response.status).toBe(200);
    expect(response.body.agent.agentId).toBe(agentId);
    expect(response.body.agent.name).toBe("HTTP Self Agent");
    expect(response.body.agent.tradeName).toBe("HTTP Trade");
    expect(response.body.agent.document).toBe("59261947000107");
    expect(response.body.agent.address).toMatchObject({
      city: "Tangara da Serra",
      state: "MT",
    });
    expect(response.body.agent.lastLoginUserId).toBe(user.userId);
    expect(response.body.agent.profileUpdatedAt).toEqual(expect.any(String));

    const persisted = await repositories.agent.findById(agentId);
    expect(persisted).not.toBeNull();
    expect(persisted?.name).toBe("HTTP Self Agent");
    expect(persisted?.tradeName).toBe("HTTP Trade");
    expect(persisted?.email).toBe("http-self@test.local");
    expect(persisted?.city).toBe("Tangara da Serra");
    expect(persisted?.lastLoginUserId).toBe(user.userId);
  });

  it("should normalize empty nullable strings to null and clear existing fields", async () => {
    const user = await registerApprovedUser(baseUrl, "normalize");
    const agentId = randomUUID();
    await seedAgent({
      agentId,
      name: "Existing Agent",
      tradeName: "Old Trade",
      phone: "1130303030",
      email: "existing@test.local",
      address: {
        city: "Cuiaba",
        state: "MT",
      },
    });

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const response = await request(baseUrl)
      .patch(`/api/v1/agents/${agentId}/profile`)
      .set("Authorization", `Bearer ${agentLoginResponse.body.accessToken as string}`)
      .send({
        name: "Existing Agent",
        tradeName: "",
        phone: "   ",
        address: {
          city: "",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.agent.tradeName).toBeNull();
    expect(response.body.agent.phone).toBeNull();
    expect(response.body.agent.address.city).toBeNull();
    expect(response.body.agent.address.state).toBe("MT");

    const persisted = await repositories.agent.findById(agentId);
    expect(persisted?.tradeName).toBeUndefined();
    expect(persisted?.phone).toBeUndefined();
    expect(persisted?.city).toBeUndefined();
    expect(persisted?.state).toBe("MT");
  });

  it("should reject updating another agentId or a token without agent_id", async () => {
    const user = await registerApprovedUser(baseUrl, "auth");
    const ownAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await seedAgent({ agentId: otherAgentId, name: "Other Agent" });

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId: ownAgentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const forbiddenResponse = await request(baseUrl)
      .patch(`/api/v1/agents/${otherAgentId}/profile`)
      .set("Authorization", `Bearer ${agentLoginResponse.body.accessToken as string}`)
      .send({
        name: "Should Fail",
      });
    expect(forbiddenResponse.status).toBe(403);

    const userTokenResponse = await request(baseUrl)
      .patch(`/api/v1/agents/${ownAgentId}/profile`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({
        name: "Should Also Fail",
      });
    expect(userTokenResponse.status).toBe(403);
  });

  it("should rate limit repeated self profile updates", async () => {
    if (env.restAgentsCommandsRateLimitMax === 0) {
      return;
    }

    const user = await registerApprovedUser(baseUrl, "rate");
    const agentId = randomUUID();

    const agentLoginResponse = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: user.email,
      password: user.password,
      agentId,
    });
    expect(agentLoginResponse.status).toBe(200);

    const responses = await Promise.all(
      Array.from({ length: env.restAgentsCommandsRateLimitMax + 1 }, (_item, index) =>
        request(baseUrl)
          .patch(`/api/v1/agents/${agentId}/profile`)
          .set("Authorization", `Bearer ${agentLoginResponse.body.accessToken as string}`)
          .send({
            name: `Rate Limited Agent ${index}`,
          }),
      ),
    );

    expect(responses.some((response) => response.status === 429)).toBe(true);
  });
});
