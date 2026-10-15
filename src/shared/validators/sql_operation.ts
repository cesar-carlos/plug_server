export const SQL_OPERATION_METHODS = [
  "sql.operation.execute",
  "sql.operation.get",
  "sql.operation.cancel",
] as const;
import { z } from "zod";
import { expectedSourceSchema } from "./source_discovery";
import { expectedStructureSchema } from "./source_schema";

const name = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sqlOperationScalarSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), value: z.string().max(65536) }),
  z.strictObject({
    type: z.literal("decimal"),
    value: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .max(128),
  }),
  z.strictObject({
    type: z.literal("integer"),
    value: z
      .string()
      .regex(/^-?\d+$/)
      .max(32),
  }),
  z.strictObject({
    type: z.literal("date"),
    value: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  }),
  z.strictObject({ type: z.literal("uuid"), value: z.uuid() }),
  z.strictObject({ type: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ type: z.literal("null"), value: z.null() }),
]);
const parameter = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), scalar: sqlOperationScalarSchema }),
  z.strictObject({ kind: z.literal("step_output"), stepId: name, output: name }),
]);
const range = z
  .strictObject({
    min: z.number().int().min(0),
    max: z.number().int().min(0).max(100000),
  })
  .refine((r) => r.min <= r.max, "Invalid row bounds");
const step = z.strictObject({
  id: name,
  effect: z.enum(["select", "insert", "update", "delete"]),
  sql: z.string().trim().min(1).max(1048576),
  params: z.record(name, parameter),
  outputs: z.record(
    name,
    z.enum(["string", "decimal", "date", "uuid", "integer", "boolean", "null"]),
  ),
  affectedRows: range.refine((r) => r.max > 0, "Write bound must be positive").optional(),
  expectedRows: range.optional(),
});
const carrier = {
  client_token: z.string().min(1).max(65536).optional(),
  clientToken: z.string().min(1).max(65536).optional(),
  auth: z.string().min(1).max(65536).optional(),
};
export const sqlOperationReferenceParamsSchema = z.strictObject({
  contractVersion: z.literal(1),
  operationId: z.uuid(),
  fingerprint: hash,
  sourcePhysicalId: hash,
  expectedSource: expectedSourceSchema.optional(),
  database: z.string().trim().min(1).max(200),
  ...carrier,
});
/** Transport validation only; no SQL parsing, rewriting or business authorization in the hub. */
export const sqlOperationExecuteParamsSchema = sqlOperationReferenceParamsSchema
  .extend({
    expectedStructure: expectedStructureSchema.optional(),
    steps: z.array(step).min(1).max(32),
    maxAffectedRows: z.number().int().positive().max(100000),
    timeoutMs: z.number().int().positive().max(300000),
  })
  .superRefine((command, ctx) => {
    if (command.expectedStructure) {
      if (!command.expectedSource)
        ctx.addIssue({
          code: "custom",
          path: ["expectedSource"],
          message: "Structure requires executing-source identity",
        });
      for (const [index, resource] of command.expectedStructure.resources.entries()) {
        if (resource.columns.some((column) => column.nullable === null))
          ctx.addIssue({
            code: "custom",
            path: ["expectedStructure", "resources", index, "columns"],
            message: "Unknown nullability cannot be an execution expectation",
          });
        if (
          resource.constraints &&
          Object.values(resource.constraints).some((keys) =>
            keys.some((key) => key.status !== "enabled"),
          )
        )
          ctx.addIssue({
            code: "custom",
            path: ["expectedStructure", "resources", index, "constraints"],
            message: "Only proven enabled constraints may be expected",
          });
      }
    }
    const previous = new Map<string, z.infer<typeof step>>();
    let writes = 0;
    for (const [index, item] of command.steps.entries()) {
      if (previous.has(item.id))
        ctx.addIssue({ code: "custom", path: ["steps", index, "id"], message: "Duplicate step" });
      if (item.effect !== "select") {
        writes++;
        if (!item.affectedRows || item.affectedRows.max > command.maxAffectedRows)
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "affectedRows"],
            message: "Write row bounds required",
          });
      }
      for (const value of Object.values(item.params))
        if (
          value.kind === "step_output" &&
          !Object.hasOwn(previous.get(value.stepId)?.outputs ?? {}, value.output)
        )
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "params"],
            message: "Unavailable step output",
          });
      if (Buffer.byteLength(item.sql, "utf8") > 1048576)
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "sql"],
          message: "SQL byte limit exceeded",
        });
      previous.set(item.id, item);
    }
    if (writes === 0)
      ctx.addIssue({ code: "custom", path: ["steps"], message: "At least one write required" });
    if (Buffer.byteLength(JSON.stringify(command), "utf8") > 2097152)
      ctx.addIssue({ code: "custom", message: "Operation payload byte limit exceeded" });
  });
