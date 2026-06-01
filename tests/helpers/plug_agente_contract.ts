import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

export const PLUG_AGENTE_SCHEMA_FILES = [
  "rpc.request.schema.json",
  "rpc.response.schema.json",
  "rpc.error.schema.json",
  "rpc.batch.request.schema.json",
  "rpc.batch.response.schema.json",
  "rpc.params.sql-execute.schema.json",
  "rpc.params.sql-execute-batch.schema.json",
  "rpc.params.sql-bulk-insert.schema.json",
  "rpc.params.sql-cancel.schema.json",
  "rpc.result.sql-execute.schema.json",
  "rpc.result.sql-execute-batch.schema.json",
  "rpc.result.sql-bulk-insert.schema.json",
  "rpc.stream.chunk.schema.json",
  "rpc.stream.complete.schema.json",
  "rpc.stream.pull.schema.json",
  "payload-frame.schema.json",
  "agent.register.schema.json",
  "agent.capabilities.schema.json",
  "agent.profile.schema.json",
  "agent.ready.schema.json",
  "rpc.params.agent-get-health.schema.json",
  "rpc.result.agent-get-health.schema.json",
  "rpc.params.agent-action-run.schema.json",
  "rpc.params.agent-action-validate-run.schema.json",
  "rpc.params.agent-action-cancel.schema.json",
  "rpc.params.agent-action-get-execution.schema.json",
  "rpc.result.agent-action-validate-run.schema.json",
  "rpc.result.agent-action-cancel.schema.json",
  "rpc.result.agent-action-get-execution.schema.json",
  "rpc.params.agent-get-profile.schema.json",
  "rpc.result.agent-get-profile.schema.json",
  "rpc.params.client-token-get-policy.schema.json",
  "rpc.result.client-token-get-policy.schema.json",
  "auto_update_diagnostics.schema.json",
] as const;

export interface PlugAgenteContractPaths {
  readonly root: string;
  readonly openRpcPath: string;
  readonly schemasDir: string;
}

export type PlugAgenteAjv = InstanceType<typeof Ajv2020>;

export const resolvePlugAgenteRoot = (): string | null => {
  const envRoot = process.env.PLUG_AGENTE_ROOT?.trim();
  const candidates = [
    envRoot,
    join(process.cwd(), "..", "plug_agente"),
    "D:/Developer/plug_database/plug_agente",
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );

  for (const root of candidates) {
    const openRpcPath = join(root, "docs", "communication", "openrpc.json");
    if (existsSync(openRpcPath)) {
      return root;
    }
  }
  return null;
};

export const getPlugAgenteContractPaths = (): PlugAgenteContractPaths | null => {
  const root = resolvePlugAgenteRoot();
  if (root === null) {
    return null;
  }
  return {
    root,
    openRpcPath: join(root, "docs", "communication", "openrpc.json"),
    schemasDir: join(root, "docs", "communication", "schemas"),
  };
};

export function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const withId = (schema: Record<string, unknown>, $id: string): Record<string, unknown> => ({
  ...schema,
  $id,
});

export const registerPlugAgenteSchemas = (ajv: PlugAgenteAjv, schemasDir: string): void => {
  const read = (name: string): Record<string, unknown> => readJsonFile(join(schemasDir, name));

  const error = read("rpc.error.schema.json");
  ajv.addSchema(error);
  ajv.addSchema(withId(error, "https://plugagente.dev/schemas/rpc.error.schema.json"));

  const request = read("rpc.request.schema.json");
  ajv.addSchema(request);
  ajv.addSchema(withId(request, "https://plugagente.dev/schemas/rpc.request.schema.json"));

  const response = read("rpc.response.schema.json");
  ajv.addSchema(response);
  ajv.addSchema(withId(response, "https://plugagente.dev/schemas/rpc.response.schema.json"));

  ajv.addSchema(read("rpc.batch.request.schema.json"));
  ajv.addSchema(read("rpc.batch.response.schema.json"));

  for (const name of PLUG_AGENTE_SCHEMA_FILES) {
    // The diagnostics push schema is agent->hub and draft-07; hub->agent AJV checks do not use it.
    if (
      name.startsWith("rpc.error") ||
      name.startsWith("rpc.request") ||
      name.startsWith("rpc.response") ||
      name === "rpc.batch.request.schema.json" ||
      name === "rpc.batch.response.schema.json" ||
      name === "auto_update_diagnostics.schema.json"
    ) {
      continue;
    }
    const schema = read(name);
    ajv.addSchema(schema);
    ajv.addSchema(withId(schema, `https://plugagente.dev/schemas/${name}`));
  }
};

export const createPlugAgenteAjv = (schemasDir: string): PlugAgenteAjv => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  registerPlugAgenteSchemas(ajv, schemasDir);
  return ajv;
};
