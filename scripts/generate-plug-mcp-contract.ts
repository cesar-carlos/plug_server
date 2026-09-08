import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildSwaggerSpec } from "../src/presentation/docs/swagger";

type JsonRecord = Record<string, unknown>;
type OpenApi = {
  openapi?: string;
  info?: { version?: string };
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown>; responses?: Record<string, unknown> };
};
type FieldShape = {
  required: boolean;
  types: readonly string[];
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};
type CompatibilityBaseline = {
  contractVersion: string;
  responseFields: Record<string, readonly string[]>;
  operations?: readonly string[];
  requestFields?: Record<string, Record<string, FieldShape>>;
};

const majorArg = process.argv.find((arg) => arg.startsWith("--major="))?.slice("--major=".length);
const CONTRACT_MAJOR = Number.parseInt(majorArg ?? process.env.PLUG_MCP_CONTRACT_MAJOR ?? "1", 10);
if (!Number.isInteger(CONTRACT_MAJOR) || CONTRACT_MAJOR < 1)
  throw new Error("--major must be a positive integer");
const CONTRACT_VERSION =
  process.env.PLUG_MCP_CONTRACT_VERSION ?? `${CONTRACT_MAJOR}.${CONTRACT_MAJOR === 1 ? 1 : 0}.0`;
const target = resolve(process.cwd(), "contracts", `plug-mcp-rest-v${CONTRACT_MAJOR}.json`);
const baselineTarget = resolve(
  process.cwd(),
  "contracts",
  `plug-mcp-rest-v${CONTRACT_MAJOR}.compatibility.json`,
);
const paths = [
  "/client-auth/login",
  "/client-auth/refresh",
  "/client/me/agents",
  "/client/me/agents/{agentId}",
  "/client/me/agents/{agentId}/client-token",
  "/client/me/agent-access-requests",
  "/agents/commands",
] as const;
const operationNames = new Set(["get", "post", "put", "patch", "delete"]);

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

const resolveRef = (spec: OpenApi, value: unknown, seen = new Set<string>()): JsonRecord => {
  const row = asRecord(value);
  const ref = typeof row.$ref === "string" ? row.$ref : null;
  if (!ref || !ref.startsWith("#/")) return row;
  if (seen.has(ref)) return {};
  const targetValue = ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (current, segment) => asRecord(current)[segment.replace(/~1/g, "/").replace(/~0/g, "~")],
      spec,
    );
  return resolveRef(spec, targetValue, new Set([...seen, ref]));
};

const publicFields = (
  spec: OpenApi,
  schema: unknown,
  prefix = "",
  seen = new Set<string>(),
): string[] => {
  const original = asRecord(schema);
  const ref = typeof original.$ref === "string" ? original.$ref : null;
  if (ref && seen.has(ref)) return [];
  const row = resolveRef(spec, original, seen);
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  const fields = new Set<string>();
  for (const [name, child] of Object.entries(asRecord(row.properties))) {
    const path = prefix ? `${prefix}.${name}` : name;
    fields.add(path);
    for (const nested of publicFields(spec, child, path, nextSeen)) fields.add(nested);
  }
  if (row.items) {
    for (const nested of publicFields(spec, row.items, `${prefix}[]`, nextSeen)) fields.add(nested);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(row[key])) continue;
    for (const variant of row[key]) {
      for (const nested of publicFields(spec, variant, prefix, nextSeen)) fields.add(nested);
    }
  }
  return [...fields].sort();
};

const responseFields = (spec: OpenApi): Record<string, readonly string[]> => {
  const out: Record<string, readonly string[]> = {};
  for (const path of paths) {
    for (const [method, operationValue] of Object.entries(asRecord(spec.paths?.[path]))) {
      if (!operationNames.has(method)) continue;
      const responses = asRecord(asRecord(operationValue).responses);
      for (const [status, responseValue] of Object.entries(responses)) {
        const response = resolveRef(spec, responseValue);
        const json = asRecord(asRecord(response.content)["application/json"]);
        out[`${method.toUpperCase()} ${path} ${status}`] = publicFields(spec, json.schema);
      }
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

const fieldShape = (
  spec: OpenApi,
  schema: unknown,
  prefix = "",
  required = false,
  seen = new Set<string>(),
): Record<string, FieldShape> => {
  const original = asRecord(schema);
  const ref = typeof original.$ref === "string" ? original.$ref : null;
  if (ref && seen.has(ref)) return {};
  const row = resolveRef(spec, original, seen);
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  const out: Record<string, FieldShape> = {};
  const types = Array.isArray(row.type)
    ? row.type.filter((item): item is string => typeof item === "string")
    : typeof row.type === "string"
      ? [row.type]
      : [];
  if (prefix) {
    out[prefix] = {
      required,
      types,
      ...(Array.isArray(row.enum) ? { enum: row.enum.map(String).sort() } : {}),
      ...(typeof row.minimum === "number" ? { minimum: row.minimum } : {}),
      ...(typeof row.maximum === "number" ? { maximum: row.maximum } : {}),
      ...(typeof row.minLength === "number" ? { minLength: row.minLength } : {}),
      ...(typeof row.maxLength === "number" ? { maxLength: row.maxLength } : {}),
    };
  }
  const requiredFields = new Set(
    Array.isArray(row.required)
      ? row.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  for (const [name, child] of Object.entries(asRecord(row.properties))) {
    const path = prefix ? `${prefix}.${name}` : name;
    Object.assign(out, fieldShape(spec, child, path, requiredFields.has(name), nextSeen));
  }
  if (row.items) Object.assign(out, fieldShape(spec, row.items, `${prefix}[]`, false, nextSeen));
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(row[key]))
      for (const item of row[key])
        Object.assign(out, fieldShape(spec, item, prefix, required, nextSeen));
  }
  return out;
};

const requestFields = (spec: OpenApi): Record<string, Record<string, FieldShape>> => {
  const out: Record<string, Record<string, FieldShape>> = {};
  for (const path of paths) {
    for (const [method, operationValue] of Object.entries(asRecord(spec.paths?.[path]))) {
      if (!operationNames.has(method)) continue;
      const request = asRecord(asRecord(operationValue).requestBody);
      const json = asRecord(asRecord(request.content)["application/json"]);
      out[`${method.toUpperCase()} ${path}`] = fieldShape(spec, json.schema);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

const buildContract = (): Record<string, unknown> => {
  const spec = buildSwaggerSpec().spec as OpenApi;
  return {
    contractVersion: CONTRACT_VERSION,
    openapi: spec.openapi,
    apiVersion: spec.info?.version,
    paths: Object.fromEntries(paths.map((path) => [path, spec.paths?.[path] ?? null])),
    schemas: spec.components?.schemas ?? {},
    compatibility: {
      baseline: `plug-mcp-rest-v${CONTRACT_MAJOR}.compatibility.json`,
      policy:
        "additive fields are compatible; removals require a major version and explicit baseline update",
      responseFields: responseFields(spec),
      requestFields: requestFields(spec),
    },
    guarantees: {
      agentCommands: ["client_token.getPolicy", "sql.execute"],
      requestServerTimings: true,
      sqlExecutionMetadata: ["sql_handling_mode", "max_rows_handling", "effective_max_rows"],
      errorEnvelope: "success/error with optional serverTimings",
    },
  };
};

const compatibilityFrom = (contract: Record<string, unknown>): CompatibilityBaseline => {
  const fields = asRecord(asRecord(contract.compatibility).responseFields);
  return {
    contractVersion:
      typeof contract.contractVersion === "string" ? contract.contractVersion : CONTRACT_VERSION,
    responseFields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string").sort()
          : [],
      ]),
    ),
    operations: Object.keys(asRecord(contract.paths)).sort(),
    requestFields: Object.fromEntries(
      Object.entries(asRecord(asRecord(contract.compatibility).requestFields)).map(
        ([operation, values]) => [operation, asRecord(values) as Record<string, FieldShape>],
      ),
    ),
  };
};

const breakingChanges = (
  baseline: CompatibilityBaseline,
  current: CompatibilityBaseline,
): string[] => {
  const failures: string[] = [];
  for (const [response, fields] of Object.entries(baseline.responseFields)) {
    const currentFields = current.responseFields[response];
    if (!currentFields) {
      failures.push(`response removed: ${response}`);
      continue;
    }
    const actual = new Set(currentFields);
    for (const field of fields)
      if (!actual.has(field)) failures.push(`public field removed: ${response} :: ${field}`);
  }
  for (const operation of baseline.operations ?? []) {
    if (!(current.operations ?? []).includes(operation))
      failures.push(`operation removed: ${operation}`);
  }
  for (const [operation, fields] of Object.entries(baseline.requestFields ?? {})) {
    const actual = current.requestFields?.[operation];
    if (!actual) {
      failures.push(`request removed: ${operation}`);
      continue;
    }
    for (const [path, expected] of Object.entries(fields)) {
      const received = actual[path];
      if (!received) {
        failures.push(`request field removed: ${operation} :: ${path}`);
        continue;
      }
      if (!expected.required && received.required)
        failures.push(`request field became required: ${operation} :: ${path}`);
      if (stable(expected.types) !== stable(received.types))
        failures.push(`request field type changed: ${operation} :: ${path}`);
      if (expected.enum?.some((item) => !received.enum?.includes(item)))
        failures.push(`request enum narrowed: ${operation} :: ${path}`);
      if (
        expected.minimum !== undefined &&
        (received.minimum ?? Number.NEGATIVE_INFINITY) > expected.minimum
      )
        failures.push(`request minimum narrowed: ${operation} :: ${path}`);
      if (
        expected.maximum !== undefined &&
        (received.maximum ?? Number.POSITIVE_INFINITY) < expected.maximum
      )
        failures.push(`request maximum narrowed: ${operation} :: ${path}`);
      if (expected.minLength !== undefined && (received.minLength ?? 0) > expected.minLength)
        failures.push(`request minLength narrowed: ${operation} :: ${path}`);
      if (
        expected.maxLength !== undefined &&
        (received.maxLength ?? Number.POSITIVE_INFINITY) < expected.maxLength
      )
        failures.push(`request maxLength narrowed: ${operation} :: ${path}`);
    }
  }
  return failures;
};

const baselineAdditions = (
  baseline: CompatibilityBaseline,
  current: CompatibilityBaseline,
): string[] => {
  const additions: string[] = [];
  for (const [response, fields] of Object.entries(current.responseFields)) {
    const baselineFields = baseline.responseFields[response];
    if (!baselineFields) {
      additions.push(`public response not tracked by baseline: ${response}`);
      continue;
    }
    const known = new Set(baselineFields);
    for (const field of fields)
      if (!known.has(field))
        additions.push(`public field not tracked by baseline: ${response} :: ${field}`);
  }
  for (const operation of current.operations ?? []) {
    if (!(baseline.operations ?? []).includes(operation))
      additions.push(`public operation not tracked by baseline: ${operation}`);
  }
  for (const [operation, fields] of Object.entries(current.requestFields ?? {})) {
    const known = baseline.requestFields?.[operation] ?? {};
    for (const path of Object.keys(fields))
      if (!known[path])
        additions.push(`public request field not tracked by baseline: ${operation} :: ${path}`);
  }
  return additions;
};

const major = (version: string): number => Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;
const minor = (version: string): number => Number.parseInt(version.split(".")[1] ?? "0", 10) || 0;
const contract = buildContract();
const serialized = `${stable(contract)}\n`;
const currentCompatibility = compatibilityFrom(contract);
const check = process.argv.includes("--check");
const updateBaseline = process.argv.includes("--update-baseline");
const acceptBreaking = process.argv.includes("--accept-breaking");

if (check) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== serialized) {
    throw new Error(
      `contracts/plug-mcp-rest-v${CONTRACT_MAJOR}.json is stale; run npm run contract:generate`,
    );
  }
  if (!existsSync(baselineTarget)) {
    throw new Error(
      `contracts/plug-mcp-rest-v${CONTRACT_MAJOR}.compatibility.json is missing; run npm run contract:baseline once`,
    );
  }
  const baseline = JSON.parse(readFileSync(baselineTarget, "utf8")) as CompatibilityBaseline;
  const breaking = breakingChanges(baseline, currentCompatibility);
  if (breaking.length > 0)
    throw new Error(`MCP REST breaking change detected:\n${breaking.join("\n")}`);
  const additions = baselineAdditions(baseline, currentCompatibility);
  if (additions.length > 0)
    throw new Error(
      `MCP REST compatibility baseline is stale; run npm run contract:baseline:\n${additions.join("\n")}`,
    );
} else if (updateBaseline) {
  const previous = existsSync(baselineTarget)
    ? (JSON.parse(readFileSync(baselineTarget, "utf8")) as CompatibilityBaseline)
    : null;
  const breaking = previous ? breakingChanges(previous, currentCompatibility) : [];
  const additions = previous ? baselineAdditions(previous, currentCompatibility) : [];
  if (
    breaking.length > 0 &&
    (!acceptBreaking ||
      major(currentCompatibility.contractVersion) <= major(previous!.contractVersion))
  ) {
    throw new Error(
      `Refusing to replace a compatibility baseline without a major contractVersion and --accept-breaking:\n${breaking.join("\n")}`,
    );
  }
  if (
    additions.length > 0 &&
    previous &&
    major(currentCompatibility.contractVersion) === major(previous.contractVersion) &&
    minor(currentCompatibility.contractVersion) <= minor(previous.contractVersion)
  ) {
    throw new Error(
      `Public additions require an explicit minor contractVersion before updating the baseline:\n${additions.join("\n")}`,
    );
  }
  mkdirSync(resolve(process.cwd(), "contracts"), { recursive: true });
  writeFileSync(baselineTarget, `${stable(currentCompatibility)}\n`, "utf8");
} else {
  mkdirSync(resolve(process.cwd(), "contracts"), { recursive: true });
  writeFileSync(target, serialized, "utf8");
}
