import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { env } from "../../src/shared/config/env";

const app = createApp();

describe("Swagger docs", () => {
  it("should serve /docs/ HTML and swagger-ui static assets (no 5xx at app layer)", async () => {
    const page = await request(app).get("/docs/");
    expect([200, 301, 302]).toContain(page.status);
    if (page.status === 200) {
      expect(page.headers["content-type"] ?? "").toMatch(/text\/html/i);
    }

    const bundle = await request(app).get("/docs/swagger-ui-bundle.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers["content-type"] ?? "").toMatch(/javascript/);

    const favicon = await request(app).get("/docs/favicon-16x16.png");
    expect([200, 404]).toContain(favicon.status);

    const appFavicon = await request(app).get("/assets/icons/favicon.ico");
    expect(appFavicon.status).toBe(200);
    expect(appFavicon.headers["content-type"] ?? "").toMatch(/icon|octet-stream/i);

    if (page.status === 200 && typeof page.text === "string") {
      expect(page.text).toContain("/assets/icons/favicon.ico");
    }
  });

  it("should expose /docs.json with method-specific REST bridge schemas", async () => {
    const response = await request(app).get("/docs.json");

    expect(response.status).toBe(200);
    expect(response.body.info?.title).toBe(`${env.appName} API`);
    expect(String(response.body.info?.description ?? "")).toContain(env.appName);

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
    expect(schemas?.ErrorResponse?.required).toEqual(["success", "message", "code", "error"]);
    expect(schemas?.ErrorResponse?.properties?.success?.enum).toEqual([false]);
    expect(schemas?.ErrorResponse?.properties?.error?.required).toEqual(["code", "message"]);
    expect(schemas?.RpcSqlExecuteCommand?.properties?.params?.$ref).toBe(
      "#/components/schemas/SqlExecuteParams",
    );
    expect(schemas?.RpcClientTokenCarrierParams).toBeDefined();
    expect(schemas?.RpcAgentGetHealthCommand?.properties?.params?.$ref).toBe(
      "#/components/schemas/RpcClientTokenCarrierParams",
    );
    expect(schemas?.RpcAgentGetProfileCommand?.properties?.params?.$ref).toBe(
      "#/components/schemas/RpcClientTokenCarrierParams",
    );
    expect(schemas?.RpcClientTokenGetPolicyCommand?.properties?.params?.$ref).toBe(
      "#/components/schemas/RpcClientTokenCarrierParams",
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
    const socketEventsPost = response.body.paths?.["/client/me/socket-events"]?.post;
    expect(socketEventsPost?.tags).toContain("Client Socket Events");
    expect(socketEventsPost?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/ClientSocketEventPublishRequest",
    );
    expect(socketEventsPost?.requestBody?.content?.["multipart/form-data"]?.schema?.$ref).toBe(
      "#/components/schemas/ClientSocketEventMultipartPublishRequest",
    );
    expect(schemas?.ClientSocketEventPublishResponse).toBeDefined();
    expect(response.body.paths?.["/client/me/agents"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "search" }),
        expect.objectContaining({ name: "page" }),
        expect.objectContaining({ name: "pageSize" }),
        expect.objectContaining({ name: "refresh" }),
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
    expect(response.body.paths?.["/client/me/agents/{agentId}"]?.delete).toBeDefined();
    expect(response.body.paths?.["/me/clients"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/clients/{clientId}"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/clients/{clientId}/status"]?.patch).toBeDefined();
    expect(response.body.paths?.["/me/client-access-requests"]?.get).toBeDefined();
    expect(
      response.body.paths?.["/me/client-access-requests/{requestId}/approve"]?.post,
    ).toBeDefined();
    expect(
      response.body.paths?.["/me/client-access-requests/{requestId}/reject"]?.post,
    ).toBeDefined();
    expect(response.body.paths?.["/me/agents/{agentId}/clients"]?.get).toBeDefined();
    expect(response.body.paths?.["/me/agents/{agentId}/clients/{clientId}"]?.delete).toBeDefined();
    expect(response.body.paths?.["/client-auth/register"]?.post?.security).toBeUndefined();
    const clientRegisterBody =
      response.body.paths?.["/client-auth/register"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema?.properties;
    expect(clientRegisterBody?.ownerEmail).toBeDefined();
    expect(clientRegisterBody?.userId).toBeUndefined();
    expect(response.body.paths?.["/client-auth/register"]?.post?.responses?.["400"]).toBeDefined();
    expect(
      response.body.paths?.["/client-auth/register"]?.post?.responses?.["404"],
    ).toBeUndefined();
    expect(response.body.paths?.["/client-auth/registration/review"]?.get).toBeDefined();
    expect(response.body.paths?.["/client-auth/registration/status"]?.get).toBeDefined();
    expect(response.body.paths?.["/client-auth/registration/approve"]?.post).toBeDefined();
    expect(response.body.paths?.["/client-auth/registration/reject"]?.post).toBeDefined();
    expect(
      response.body.paths?.["/auth/registration/retry"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema?.required,
    ).toEqual(["email", "password"]);
    expect(
      response.body.paths?.["/client-auth/registration/retry"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema?.required,
    ).toEqual(["ownerEmail", "email", "password"]);
    expect(
      response.body.paths?.["/client/me/agent-access-requests/{requestId}/retry"]?.post?.parameters,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "requestId", in: "path" })]));
    expect(response.body.paths?.["/me/agents"]?.get?.tags).toContain("User agents");
    expect(response.body.paths?.["/users/{userId}/agents"]?.get?.tags).toContain("User agents");
    expect(response.body.paths?.["/me/agents"]?.post).toBeUndefined();
    expect(response.body.paths?.["/me/agents"]?.delete).toBeUndefined();
    expect(response.body.paths?.["/users/{userId}/agents"]?.post).toBeUndefined();
    expect(response.body.paths?.["/users/{userId}/agents"]?.delete).toBeUndefined();
    expect(response.body.paths?.["/users/{userId}/agents"]?.put).toBeUndefined();
    expect(response.body.paths?.["/auth/agent-login"]?.post?.responses?.["409"]).toBeDefined();
    expect(response.body.paths?.["/auth/agent-login"]?.post?.responses?.["404"]).toBeUndefined();
    expect(response.body.paths?.["/auth/login"]?.post?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/api/v1" }),
        expect.objectContaining({ url: "/" }),
      ]),
    );
    expect(response.body.paths?.["/metrics"]?.get?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/api/v1" }),
        expect.objectContaining({ url: "/" }),
      ]),
    );
    const agentsProfilePatch = response.body.paths?.["/agents/{agentId}/profile"]?.patch;
    expect(agentsProfilePatch?.tags).toContain("Agents");
    expect(
      agentsProfilePatch?.responses?.["409"]?.content?.["application/json"]?.schema?.$ref,
    ).toBe("#/components/schemas/ErrorResponse");
    expect(
      agentsProfilePatch?.parameters?.some(
        (p: { name?: string; in?: string }) => p.name === "Idempotency-Key" && p.in === "header",
      ),
    ).toBe(true);
    expect(agentsProfilePatch?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/AgentSelfProfilePatchRequest",
    );
    expect(schemas?.AgentCatalogRecord?.properties).toHaveProperty("cnpjCpf");
    expect(schemas?.AgentSelfProfilePatchRequest?.properties).toHaveProperty("tradeName");
    expect(schemas?.AgentSelfProfilePatchRequest?.properties).toHaveProperty("address");
    expect(schemas?.ClientAccessibleAgent?.properties).toHaveProperty("profileUpdatedAt");
    expect(schemas?.ClientAccessibleAgent?.properties).toHaveProperty("isHubConnected");
    expect(schemas?.CreateAgentCatalogRequest).toBeUndefined();
    expect(schemas?.UpdateAgentCatalogRequest).toBeUndefined();
    expect(schemas?.PaginatedAgentCatalogResponse?.required).toContain("total");
    expect(response.body.paths?.["/agents/commands"]?.post?.servers).toBeUndefined();
  });
});
