import { z } from "zod";
import {
  sourceSchemaParamsSchema,
  sourceSchemaResultSchema,
  expectedStructureSchema,
} from "../../../shared/validators/source_schema";
import {
  sourceDiscoveryParamsSchema,
  expectedSourceSchema,
  sourceDiscoveryResultSchema,
} from "../../../shared/validators/source_discovery";
export const sourceDiscoveryBridgeSchemas = {
  ExpectedStructure: z.toJSONSchema(expectedStructureSchema, { target: "openapi-3.0" }),
  SourceSchemaParams: z.toJSONSchema(sourceSchemaParamsSchema, { target: "openapi-3.0" }),
  SourceSchemaResult: z.toJSONSchema(sourceSchemaResultSchema, { target: "openapi-3.0" }),
  RpcSourceSchemaCommand: {
    type: "object",
    required: ["method", "params"],
    properties: {
      method: { type: "string", enum: ["sql.describeSchema"] },
      params: { $ref: "#/components/schemas/SourceSchemaParams" },
    },
  },
  ExpectedSource: z.toJSONSchema(expectedSourceSchema, { target: "openapi-3.0" }),
  SourceDiscoveryParams: z.toJSONSchema(sourceDiscoveryParamsSchema, { target: "openapi-3.0" }),
  SourceDiscoveryResult: z.toJSONSchema(sourceDiscoveryResultSchema, { target: "openapi-3.0" }),
  RpcSourceDiscoveryCommand: {
    type: "object",
    required: ["method", "params"],
    additionalProperties: true,
    properties: {
      jsonrpc: { type: "string", enum: ["2.0"] },
      id: { oneOf: [{ type: "string" }, { type: "number" }] },
      method: { type: "string", enum: ["sql.describeSource"] },
      params: { $ref: "#/components/schemas/SourceDiscoveryParams" },
    },
  },
};
