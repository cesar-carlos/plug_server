import { randomUUID } from "node:crypto";

import type { Agent } from "../../domain/entities/agent.entity";
import type { AgentCommandDispatcher } from "../agent_commands/execute_agent_command";
import { AppError } from "../../shared/errors/app_error";
import { forbidden } from "../../shared/errors/http_errors";
import { logger } from "../../shared/utils/logger";
import type {
  AgentPulledProfilePayload,
  AgentSelfProfileService,
} from "./agent_self_profile.service";
import { agentProfileReliabilityMetrics } from "./agent_profile_reliability_metrics.service";

export interface SyncAgentProfileInput {
  readonly agentId: string;
  readonly userId?: string;
  readonly dispatch: AgentCommandDispatcher;
  readonly timeoutMs?: number;
}

export interface AgentRegisterProfileSnapshot {
  readonly profile: unknown;
  readonly profileVersion: number;
  readonly profileUpdatedAt: Date;
}

export interface SyncAgentRegisterSnapshotInput {
  readonly agentId: string;
  readonly userId?: string;
  readonly snapshot: AgentRegisterProfileSnapshot;
}

export interface AgentProfileSyncRpcErrorDetails {
  readonly rpc_code?: number;
  readonly rpc_message?: string;
  readonly rpc_reason?: string;
  readonly technical_message?: string;
  readonly retryable?: boolean;
  readonly retry_after_ms?: number;
}

export class AgentProfileSyncRpcError extends AppError {
  constructor(message: string, details: AgentProfileSyncRpcErrorDetails) {
    super(message, {
      statusCode: 502,
      code: "AGENT_PROFILE_SYNC_RPC_ERROR",
      details,
    });
  }
}

export class AgentProfileSyncService {
  constructor(private readonly agentSelfProfileService: AgentSelfProfileService) {}

  async syncFromRegisterSnapshot(input: SyncAgentRegisterSnapshotInput): Promise<Agent> {
    const profile = parseProfile(input.snapshot.profile);
    agentProfileReliabilityMetrics.profileSyncRegisterSnapshotTotal += 1;
    return this.agentSelfProfileService.persistProfilePatch({
      agentId: input.agentId,
      patch: this.agentSelfProfileService.toPatchFromPulledProfile(profile),
      source: "pull_sync",
      profileUpdatedAt: input.snapshot.profileUpdatedAt,
      remoteProfileVersion: input.snapshot.profileVersion,
      ...(input.userId !== undefined ? { lastLoginUserId: input.userId } : {}),
    });
  }

  async syncFromConnectedAgent(input: SyncAgentProfileInput): Promise<Agent> {
    agentProfileReliabilityMetrics.profileSyncFallbackRpcTotal += 1;
    const result = await input.dispatch({
      agentId: input.agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getProfile",
        id: randomUUID(),
        params: { include_diagnostics: false },
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
      throw new AgentProfileSyncRpcError(message, buildRpcErrorDetails(errorPayload));
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

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const buildRpcErrorDetails = (
  errorPayload: Record<string, unknown>,
): AgentProfileSyncRpcErrorDetails => {
  const data = toRecord(errorPayload.data);
  const rpcCode = readNumber(errorPayload.code);
  const rpcMessage = readString(errorPayload.message);
  const rpcReason = readString(data?.reason);
  const technicalMessage = readString(data?.technical_message);
  const retryable = readBoolean(data?.retryable);
  const retryAfterMs = readNumber(data?.retry_after_ms);
  return {
    ...(rpcCode !== undefined ? { rpc_code: rpcCode } : {}),
    ...(rpcMessage !== undefined ? { rpc_message: rpcMessage } : {}),
    ...(rpcReason !== undefined ? { rpc_reason: rpcReason } : {}),
    ...(technicalMessage !== undefined ? { technical_message: technicalMessage } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(retryAfterMs !== undefined
      ? { retry_after_ms: Math.max(0, Math.floor(retryAfterMs)) }
      : {}),
  };
};

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
