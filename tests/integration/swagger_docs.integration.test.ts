import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";

const app = createApp();

describe("Swagger docs", () => {
  it("should expose /docs.json with method-specific REST bridge schemas", async () => {
    const response = await request(app).get("/docs.json");

    expect(response.status).toBe(200);

    const agentsCommandsPost = response.body.paths?.["/agents/commands"]?.post;
    expect(agentsCommandsPost?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/AgentCommandRequest",
    );
    expect(
      agentsCommandsPost?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    ).toBe("#/components/schemas/AgentCommandResponse200");
    expect(
      agentsCommandsPost?.responses?.["202"]?.content?.["application/json"]?.schema?.$ref,
    ).toBe("#/components/schemas/AgentCommandResponse202");

    const schemas = response.body.components?.schemas;
    expect(schemas?.RpcSqlExecuteCommand?.properties?.params?.$ref).toBe(
      "#/components/schemas/SqlExecuteParams",
    );
    expect(schemas?.RpcSqlExecuteCommand?.properties).toHaveProperty("api_version");
    expect(schemas?.RpcSqlExecuteCommand?.properties).toHaveProperty("meta");
    expect(schemas?.SqlExecuteBatchCommandItem?.properties).toHaveProperty("execution_order");
    expect(schemas?.NormalizedRpcItem?.properties).toHaveProperty("api_version");
    expect(schemas?.NormalizedRpcItem?.properties).toHaveProperty("meta");

    expect(response.body.paths?.["/agents/catalog"]?.get?.tags).toContain("Agent catalog");
    expect(response.body.paths?.["/agents/catalog"]?.post).toBeUndefined();
    expect(response.body.paths?.["/agents/catalog/{agentId}"]?.patch).toBeUndefined();
    expect(response.body.paths?.["/client/me/agents"]?.get?.tags).toContain("Client Agent Access");
    expect(response.body.paths?.["/client/me/agents"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "search" }),
        expect.objectContaining({ name: "page" }),
        expect.objectContaining({ name: "pageSize" }),
      ]),
    );
    expect(response.body.paths?.["/client/me/agent-access-requests"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "search" }),
        expect.objectContaining({ name: "page" }),
        expect.objectContaining({ name: "pageSize" }),
      ]),
    );
    expect(response.body.paths?.["/client/me/agents/{agentId}"]?.get?.tags).toContain(
      "Client Agent Access",
    );
    expect(response.body.paths?.["/me/clients"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/clients/{clientId}"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/clients/{clientId}/status"]?.patch).toBeDefined();
    expect(response.body.paths?.["/me/client-access-requests"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/client-access-requests/{requestId}/approve"]?.post).toBeDefined();
    expect(response.body.paths?.["/me/client-access-requests/{requestId}/reject"]?.post).toBeDefined();
    expect(response.body.paths?.["/me/agents/{agentId}/clients"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/agents/{agentId}/clients/{clientId}"]?.delete).toBeDefined();
    expect(response.body.paths?.["/client-auth/register"]?.post?.security).toBeUndefined();
    const clientRegisterBody =
      response.body.paths?.["/client-auth/register"]?.post?.requestBody?.content?.["application/json"]?.schema
        ?.properties;
    expect(clientRegisterBody?.ownerEmail).toBeDefined();
    expect(clientRegisterBody?.userId).toBeUndefined();
    expect(response.body.paths?.["/client-auth/register"]?.post?.responses?.["400"]).toBeDefined();
    expect(response.body.paths?.["/client-auth/register"]?.post?.responses?.["404"]).toBeUndefined();
    expect(response.body.paths?.["/client-auth/registration/review"]?.get).toBeDefined();
    expect(response.body.paths?.["/client-auth/registration/status"]?.get).toBeDefined();
    expect(response.body.paths?.["/client-auth/registration/approve"]?.post).toBeDefined();
    expect(response.body.paths?.["/client-auth/registration/reject"]?.post).toBeDefined();
    expect(response.body.paths?.["/me/agents"]?.get?.tags).toContain("User agents");
    expect(response.body.paths?.["/users/{userId}/agents"]?.get?.tags).toContain("User agents");
    expect(response.body.paths?.["/me/agents"]?.post).toBeUndefined();
    expect(response.body.paths?.["/me/agents"]?.delete).toBeUndefined();
    expect(response.body.paths?.["/users/{userId}/agents"]?.post).toBeUndefined();
    expect(response.body.paths?.["/users/{userId}/agents"]?.delete).toBeUndefined();
    expect(response.body.paths?.["/users/{userId}/agents"]?.put).toBeUndefined();
    expect(response.body.paths?.["/auth/agent-login"]?.post?.responses?.["409"]).toBeDefined();
    expect(response.body.paths?.["/auth/agent-login"]?.post?.responses?.["404"]).toBeUndefined();
    expect(schemas?.AgentCatalogRecord?.properties).toHaveProperty("cnpjCpf");
    expect(schemas?.ClientAccessibleAgent?.properties).toHaveProperty("profileUpdatedAt");
    expect(schemas?.CreateAgentCatalogRequest).toBeUndefined();
    expect(schemas?.UpdateAgentCatalogRequest).toBeUndefined();
    expect(schemas?.PaginatedAgentCatalogResponse?.required).toContain("total");
  });
});
