import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { supportedAgentRpcMethods } from "../../src/shared/validators/agent_command";

const app = createApp();

const toRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const toSortedUnique = (values: readonly string[]): readonly string[] =>
  Array.from(new Set(values)).sort();

const resolveOpenRpcPath = (): string => {
  const explicitPath = process.env.PLUG_AGENTE_OPENRPC_PATH;
  const candidates = [
    explicitPath,
    path.resolve(process.cwd(), "../plug_agente/docs/communication/openrpc.json"),
    "D:/Developer/plug_database/plug_agente/docs/communication/openrpc.json",
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      "OpenRPC contract file not found.",
      "Set PLUG_AGENTE_OPENRPC_PATH or ensure ../plug_agente/docs/communication/openrpc.json exists.",
      `Checked paths: ${candidates.join(", ")}`,
    ].join(" "),
  );
};

const readOpenRpcMethods = (): readonly string[] => {
  const openRpcPath = resolveOpenRpcPath();
  const parsed = JSON.parse(fs.readFileSync(openRpcPath, "utf8")) as unknown;
  const record = toRecord(parsed);
  if (!record || !Array.isArray(record.methods)) {
    throw new Error(`Invalid OpenRPC document at ${openRpcPath}`);
  }

  const methods = record.methods
    .map((item) => toRecord(item)?.name)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);

  return toSortedUnique(methods);
};

const readSwaggerMethods = async (): Promise<readonly string[]> => {
  const response = await request(app).get("/docs.json");
  expect(response.status).toBe(200);

  const body = toRecord(response.body);
  const components = toRecord(body?.components);
  const schemas = toRecord(components?.schemas);
  const bridgeSingleCommand = toRecord(schemas?.BridgeSingleCommand);
  const bridgeVariants = Array.isArray(bridgeSingleCommand?.oneOf) ? bridgeSingleCommand.oneOf : [];

  const methods: string[] = [];
  for (const variant of bridgeVariants) {
    const variantRecord = toRecord(variant);
    const ref = variantRecord?.$ref;
    if (typeof ref !== "string") {
      continue;
    }

    const schemaName = ref.split("/").at(-1);
    if (!schemaName) {
      continue;
    }

    const methodSchema = toRecord(schemas?.[schemaName]);
    const properties = toRecord(methodSchema?.properties);
    const methodProperty = toRecord(properties?.method);
    const methodEnum = Array.isArray(methodProperty?.enum) ? methodProperty.enum : [];
    for (const methodName of methodEnum) {
      if (typeof methodName === "string" && methodName.trim().length > 0) {
        methods.push(methodName);
      }
    }
  }

  return toSortedUnique(methods);
};

describe("RPC contract alignment", () => {
  it("should keep validator and swagger methods aligned with plug_agente OpenRPC", async () => {
    const openRpcMethods = readOpenRpcMethods();
    const validatorMethods = toSortedUnique([...supportedAgentRpcMethods]);
    const swaggerMethods = await readSwaggerMethods();

    expect(validatorMethods).toEqual(openRpcMethods);
    expect(swaggerMethods).toEqual(openRpcMethods);
  });
});
