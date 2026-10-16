import { legacyArray } from "./legacy_array";
import { z } from "zod";
import {
  sourceDiscoveryResultSchema as sourceDiscoverySchema,
  expectedSourceSchema,
} from "./source_discovery";

const identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/)
  .max(128);
export const schemaResourceSchema = z.strictObject({
  schema: identifier.nullable(),
  name: identifier,
  type: z.enum(["table", "view"]),
});
export const schemaInspectionSchema = z.strictObject({
  resources: legacyArray(schemaResourceSchema)
    .min(1)
    .max(16)
    .refine((r) => new Set(r.map((v) => JSON.stringify(v))).size === r.length),
  offset: z.number().int().min(0).max(15).default(0),
  pageSize: z.number().int().min(1).max(4).default(4),
});
const columnSchema = z.strictObject({
  name: z.string().min(1).max(128),
  nativeType: z.string().min(1).max(128),
  ordinal: z.number().int().positive(),
  nullable: z.boolean().nullable(),
  size: z.number().int().min(0).nullable(),
  scale: z.number().int().min(0).nullable(),
});
export const constraintKeySchema = z.strictObject({
  name: z.string().min(1).max(128),
  columns: legacyArray(z.string().min(1).max(128)).min(1).max(32),
  status: z.enum(["enabled", "disabled", "unvalidated", "unknown"]),
});
export const constraintForeignSchema = constraintKeySchema.extend({
  target: schemaResourceSchema,
  targetColumns: legacyArray(z.string().min(1).max(128)).min(1).max(32),
});
export const sourceSchemaResultSchema = z.strictObject({
  contractVersion: z.literal(1),
  identity: sourceDiscoverySchema,
  observedAt: z.iso.datetime({ offset: true }),
  resources: legacyArray(
    z.strictObject({
      resource: schemaResourceSchema,
      status: z.enum(["available", "not_found", "not_authorized", "unavailable"]),
      columns: legacyArray(columnSchema).max(1024),
      primaryKeys: legacyArray(constraintKeySchema).max(64),
      uniqueKeys: legacyArray(constraintKeySchema).max(64).optional(),
      foreignKeys: legacyArray(constraintForeignSchema).max(128),
      coverage: z.strictObject({
        columns: z.boolean(),
        primaryKeys: z.boolean(),
        foreignKeys: z.boolean(),
        constraintStatus: z.boolean(),
        uniqueKeys: z.boolean().optional(),
      }),
      limitations: legacyArray(
        z.enum(["metadata_unavailable", "constraint_status_unverified", "scoped_relationships"]),
      ).max(3),
    }),
  ).max(4),
  metadataPage: z.strictObject({
    offset: z.number().int().min(0),
    pageSize: z.number().int().positive(),
    nextOffset: z.number().int().min(0).nullable(),
  }),
});
export type SchemaInspection = z.infer<typeof schemaInspectionSchema>;
export type SourceSchemaEvidence = z.infer<typeof sourceSchemaResultSchema>;

export const sourceSchemaParamsSchema = schemaInspectionSchema.extend({
  contractVersion: z.literal(1),
  database: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^;{}\r\n\0]+$/),
  client_token: z.string().min(1).max(8192),
  expectedSource: expectedSourceSchema,
});

export const expectedStructureSchema = z.strictObject({
  version: z.literal(1),
  resources: legacyArray(
    z.strictObject({
      resource: schemaResourceSchema,
      columns: legacyArray(columnSchema.omit({ ordinal: true }))
        .min(1)
        .max(1024),
      constraints: z
        .strictObject({
          primaryKeys: legacyArray(constraintKeySchema).max(64),
          uniqueKeys: legacyArray(constraintKeySchema).max(64),
          foreignKeys: legacyArray(constraintForeignSchema).max(128),
        })
        .optional(),
    }),
  )
    .min(1)
    .max(16),
});
export type ExpectedStructure = z.infer<typeof expectedStructureSchema>;
