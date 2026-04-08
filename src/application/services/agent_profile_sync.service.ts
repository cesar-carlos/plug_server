import { randomUUID } from "node:crypto";

import type { Agent } from "../../domain/entities/agent.entity";
import type { AgentCommandDispatcher } from "../agent_commands/execute_agent_command";
import { forbidden } from "../../shared/errors/http_errors";
import { logger } from "../../shared/utils/logger";
import type {
  AgentPulledProfilePayload,
  AgentSelfProfileService,
} from "./agent_self_profile.service";

export interface SyncAgentProfileInput {
  readonly agentId: string;
  readonly userId?: string;
  readonly dispatch: AgentCommandDispatcher;
  readonly timeoutMs?: number;
}

export class AgentProfileSyncService {
  constructor(private readonly agentSelfProfileService: AgentSelfProfileService) {}

  async syncFromConnectedAgent(input: SyncAgentProfileInput): Promise<Agent> {
    const result = await input.dispatch({
      agentId: input.agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getProfile",
        id: randomUUID(),
        params: {},
      },
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });

    if ("notification" in result) {
      throw new Error("agent.getProfile returned notification unexpectedly");
    }

    const envelope = toRecord(result.response);
    if (!envelope) {
      throw new Error("agent.getProfile response must be an object");
    }

    if (toRecord(envelope.error)) {
      const errorPayload = toRecord(envelope.error) ?? {};
      const message =
        typeof errorPayload.message === "string"
          ? errorPayload.message
          : "agent.getProfile returned RPC error";
      throw new Error(message);
    }

    const rpcResult = toRecord(envelope.result);
    if (!rpcResult) {
      throw new Error("agent.getProfile response is missing result");
    }

    const profile = parseProfile(rpcResult.profile);
    const updatedAt = parseOptionalDate(rpcResult.updated_at);
    const remoteProfileVersion = parseOptionalNonNegativeInt(rpcResult.profile_version);
    const responseAgentId = readString(rpcResult.agent_id);
    if (responseAgentId && responseAgentId !== input.agentId) {
      logger.warn("agent_profile_sync_agent_id_mismatch", {
        expectedAgentId: input.agentId,
        responseAgentId,
      });
      throw forbidden("agent.getProfile agent_id does not match authenticated agent");
    }

    if (updatedAt === undefined) {
      logger.warn("agent_profile_sync_missing_updated_at", {
        agentId: input.agentId,
      });
    }

    return this.agentSelfProfileService.persistProfilePatch({
      agentId: input.agentId,
      patch: this.agentSelfProfileService.toPatchFromPulledProfile(profile),
      source: "pull_sync",
      ...(updatedAt !== undefined ? { profileUpdatedAt: updatedAt } : {}),
      ...(remoteProfileVersion !== undefined ? { remoteProfileVersion } : {}),
      ...(input.userId !== undefined ? { lastLoginUserId: input.userId } : {}),
    });
  }
}

const toRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const parseOptionalDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const parseOptionalNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(n) && n >= 0) {
      return n;
    }
  }
  return undefined;
};

const parseProfile = (value: unknown): AgentPulledProfilePayload => {
  const profile = toRecord(value);
  if (!profile) {
    throw new Error("agent.getProfile profile must be an object");
  }

  const name = readString(profile.name);
  if (!name) {
    throw new Error("agent.getProfile profile.name is required");
  }

  const address = toRecord(profile.address);
  const tradeName = readString(profile.trade_name);
  const document = readString(profile.document);
  const phone = readString(profile.phone);
  const mobile = readString(profile.mobile);
  const email = readString(profile.email);
  const notes = readString(profile.notes);
  const addressStreet = readString(address?.street);
  const addressNumber = readString(address?.number);
  const addressDistrict = readString(address?.district);
  const addressPostalCode = readString(address?.postal_code);
  const addressCity = readString(address?.city);
  const addressState = readString(address?.state);

  return {
    name,
    ...(tradeName !== undefined ? { trade_name: tradeName } : {}),
    ...(document !== undefined ? { document } : {}),
    ...(profile.document_type === "cpf" || profile.document_type === "cnpj"
      ? { document_type: profile.document_type }
      : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(mobile !== undefined ? { mobile } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(address
      ? {
          address: {
            ...(addressStreet !== undefined ? { street: addressStreet } : {}),
            ...(addressNumber !== undefined ? { number: addressNumber } : {}),
            ...(addressDistrict !== undefined ? { district: addressDistrict } : {}),
            ...(addressPostalCode !== undefined ? { postal_code: addressPostalCode } : {}),
            ...(addressCity !== undefined ? { city: addressCity } : {}),
            ...(addressState !== undefined ? { state: addressState } : {}),
          },
        }
      : {}),
  };
};
