import { z } from "zod";

const agentReadyPayloadSchema = z
  .object({
    agent_id: z.string().min(1),
    timestamp: z.string().datetime({ offset: true }),
    protocol: z.string().min(1),
  })
  .strict();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export type AgentReadyPayloadParseResult =
  | {
      readonly ok: true;
      readonly legacy: false;
      readonly agentId: string;
    }
  | {
      readonly ok: true;
      readonly legacy: true;
      readonly agentId: string;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_payload" | "invalid_partial_payload";
    };

export const parseAgentReadyPayload = (payload: unknown): AgentReadyPayloadParseResult => {
  const parsed = agentReadyPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return {
      ok: true,
      legacy: false,
      agentId: parsed.data.agent_id,
    };
  }

  if (!isRecord(payload)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim() : "";
  if (agentId === "") {
    return { ok: false, reason: "invalid_payload" };
  }

  const hasTimestamp = payload.timestamp !== undefined;
  const hasProtocol = payload.protocol !== undefined;
  if (!hasTimestamp && !hasProtocol) {
    return {
      ok: true,
      legacy: true,
      agentId,
    };
  }

  return { ok: false, reason: "invalid_partial_payload" };
};
