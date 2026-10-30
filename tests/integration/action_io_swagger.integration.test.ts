import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";

const app = createApp();

describe("served action I/O OpenAPI contract", () => {
  it("uses OpenAPI 3.0 singleton enums instead of unsupported const", async () => {
    const response = await request(app).get("/docs.json");
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.0.0");
    const config = response.body.components.schemas.ActionIoConfiguration;
    expect(config.properties.version).toEqual({ type: "integer", enum: [1] });
    expect(config.properties.mode).toEqual({ type: "string", enum: ["faithful"] });
    expect(config.required).toEqual(["version", "mode", "close_input"]);
    expect(config.additionalProperties).toBe(false);
  });

  it.each([
    ["SendInput", "sendInput"],
    ["CloseInput", "closeInput"],
    ["GetInputStatus", "getInputStatus"],
    ["ReadIo", "readIo"],
    ["FindExecution", "findExecution"],
  ])("exposes the %s method and its dedicated parameters", async (name, method) => {
    const response = await request(app).get("/docs.json");
    expect(response.status).toBe(200);
    const schemas = response.body.components.schemas;
    const command = schemas[`RpcActionIo${name}Command`];
    expect(command.properties.method.enum).toEqual([`agent.action.${method}`]);
    expect(command.properties.params.$ref).toBe(`#/components/schemas/ActionIo${name}Params`);
    expect(schemas[`ActionIo${name}Params`].additionalProperties).toBe(false);
    expect(command.required).toContain("id");
  });
});
