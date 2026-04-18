/**
 * Zod schema for the `agent:register` payload received from agents on the
 * `/agents` namespace, aligned with plug_agente
 * `docs/communication/schemas/agent.register.schema.json`.
 *
 * The schema validates the **decoded** logical payload (i.e. after
 * `decodePayloadFrame` produces `data`); the transport `PayloadFrame` itself
 * is validated upstream by `isPayloadFrameEnvelope`.
 *
 * NOTE: capabilities subfields (`protocols`, `encodings`, `compressions`,
 * `extensions`, `limits`) are validated only structurally (presence + type).
 * The actual values are not constrained here because the hub negotiates them
 * via `resolveDispatchPolicy` / `TransportLimits.negotiateWith` at runtime.
 */

import { z } from "zod";

const trimmedNonEmptyString = z
  .string()
  .min(1, { message: "Must not be empty" })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: "Must not be empty after trim" });

/**
 * `timestamp` is required by the agent's published schema (ISO-8601). The
 * hub keeps it **optional** here: the value is purely informational (we don't
 * use it for admission control, replay protection, or rate-limit windows),
 * and we want to stay backwards compatible with older agent builds that
 * predated the field. When sent, it must be a parseable ISO-8601 string so
 * misbehaving clients still get a clear validation error.
 */
const isoTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Must be an ISO-8601 timestamp",
  });

/**
 * The agent's published schema (`agent.register.schema.json`) marks
 * `extensions` and `limits` as required. We accept missing values as `{}` for
 * backwards compatibility with older agents that connected before those
 * fields became mandatory; the runtime negotiation paths
 * (`resolveDispatchPolicy`, `resolveStreamPullWindowPolicy`) treat empty
 * objects identically to "not advertised".
 */
const capabilitiesSchema = z
  .object({
    protocols: z.array(z.string().min(1)).min(1),
    encodings: z.array(z.string().min(1)).min(1),
    compressions: z.array(z.string().min(1)).min(1),
    extensions: z.record(z.string(), z.unknown()).default({}),
    limits: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/**
 * `profile` block is optional (added in plug_agente v2.6 when the agent has a
 * complete local registration). We accept it as an opaque object and let the
 * downstream `agent.profile.sync` flow validate semantic fields.
 */
const profileSchema = z.record(z.string(), z.unknown());

export const agentRegisterPayloadSchema = z
  .object({
    agentId: trimmedNonEmptyString,
    timestamp: isoTimestampSchema.optional(),
    capabilities: capabilitiesSchema,
    profile: profileSchema.optional(),
  })
  .passthrough();

export type AgentRegisterPayload = z.infer<typeof agentRegisterPayloadSchema>;
