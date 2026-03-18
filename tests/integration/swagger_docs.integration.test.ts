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
    expect(agentsCommandsPost?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/AgentCommandResponse200",
    );
    expect(agentsCommandsPost?.responses?.["202"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/AgentCommandResponse202",
    );

    const schemas = response.body.components?.schemas;
    expect(schemas?.RpcSqlExecuteCommand?.properties?.params?.$ref).toBe(
      "#/components/schemas/SqlExecuteParams",
    );
    expect(schemas?.RpcSqlExecuteCommand?.properties).toHaveProperty("api_version");
    expect(schemas?.RpcSqlExecuteCommand?.properties).toHaveProperty("meta");
    expect(schemas?.SqlExecuteBatchCommandItem?.properties).toHaveProperty("execution_order");
    expect(schemas?.NormalizedRpcItem?.properties).toHaveProperty("api_version");
    expect(schemas?.NormalizedRpcItem?.properties).toHaveProperty("meta");
  });
});
