import { randomUUID } from "node:crypto";

import { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { AgentCommandDispatcher } from "../agent_commands/execute_agent_command";
import { logger } from "../../shared/utils/logger";

type AgentProfilePayload = {
  readonly name: string;
  readonly trade_name?: string;
  readonly document?: string;
  readonly document_type?: "cpf" | "cnpj";
  readonly phone?: string;
  readonly mobile?: string;
  readonly email?: string;
  readonly address?: {
    readonly street?: string;
    readonly number?: string;
    readonly district?: string;
    readonly postal_code?: string;
    readonly city?: string;
    readonly state?: string;
  };
  readonly notes?: string;
};

export interface SyncAgentProfileInput {
  readonly agentId: string;
  readonly userId?: string;
  readonly dispatch: AgentCommandDispatcher;
  readonly timeoutMs?: number;
}

export class AgentProfileSyncService {
  constructor(private readonly agentRepository: IAgentRepository) {}

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
    const responseAgentId = readString(rpcResult.agent_id);
    const persistedAgentId = responseAgentId ?? input.agentId;
    if (responseAgentId && responseAgentId !== input.agentId) {
      logger.warn("agent_profile_sync_agent_id_mismatch", {
        expectedAgentId: input.agentId,
        responseAgentId,
      });
    }

    const existing = await this.agentRepository.findById(persistedAgentId);
    const profileAddress = profile.address
      ? {
          ...(profile.address.street !== undefined ? { street: profile.address.street } : {}),
          ...(profile.address.number !== undefined ? { number: profile.address.number } : {}),
          ...(profile.address.district !== undefined ? { district: profile.address.district } : {}),
          ...(profile.address.postal_code !== undefined
            ? { postalCode: profile.address.postal_code }
            : {}),
          ...(profile.address.city !== undefined ? { city: profile.address.city } : {}),
          ...(profile.address.state !== undefined ? { state: profile.address.state } : {}),
        }
      : undefined;
    const commonPayload = {
      name: profile.name,
      ...(profile.trade_name !== undefined ? { tradeName: profile.trade_name } : {}),
      ...(profile.document !== undefined ? { document: profile.document } : {}),
      ...(profile.document_type !== undefined ? { documentType: profile.document_type } : {}),
      ...(profile.phone !== undefined ? { phone: profile.phone } : {}),
      ...(profile.mobile !== undefined ? { mobile: profile.mobile } : {}),
      ...(profile.email !== undefined ? { email: profile.email } : {}),
      ...(profileAddress !== undefined ? { address: profileAddress } : {}),
      ...(profile.notes !== undefined ? { notes: profile.notes } : {}),
      profileUpdatedAt: updatedAt ?? new Date(),
      ...(input.userId !== undefined ? { lastLoginUserId: input.userId } : {}),
    };

    if (!existing) {
      const created = Agent.create({
        agentId: persistedAgentId,
        ...commonPayload,
      });
      await this.agentRepository.save(created);
      return created;
    }

    const updated = existing.update(commonPayload);
    await this.agentRepository.update(updated);
    return updated;
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

const parseProfile = (value: unknown): AgentProfilePayload => {
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
