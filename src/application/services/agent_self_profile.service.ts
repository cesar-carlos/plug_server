import {
  Agent,
  type AgentAddressPatch,
  type AgentDocumentType,
} from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import {
  agentDocumentConflict,
  agentNotFound,
  badRequest,
  conflict,
} from "../../shared/errors/http_errors";
import {
  assertSubmittedAgentProfileDocumentValid,
  normalizeAgentDocumentForStorage,
} from "../../shared/utils/agent_document_normalize";
import { logger } from "../../shared/utils/logger";
import { emitAgentProfileBroadcastEvent } from "./agent_profile_broadcast_sink";
import { agentsProfileCatalogContentEqual } from "./agent_profile_catalog_compare";
import { fingerprintAgentProfilePatch } from "./agent_profile_patch_fingerprint";
import { agentProfileReliabilityMetrics } from "./agent_profile_reliability_metrics.service";
import { agentToProfileSnapshotRecord } from "./agent_profile_snapshot";

export interface AgentSelfProfileHttpPayload {
  readonly name?: string | undefined;
  readonly tradeName?: string | null | undefined;
  readonly document?: string | null | undefined;
  readonly documentType?: AgentDocumentType | null | undefined;
  readonly phone?: string | null | undefined;
  readonly mobile?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly address?:
    | {
        readonly street?: string | null | undefined;
        readonly number?: string | null | undefined;
        readonly district?: string | null | undefined;
        readonly postalCode?: string | null | undefined;
        readonly city?: string | null | undefined;
        readonly state?: string | null | undefined;
      }
    | null
    | undefined;
  readonly notes?: string | null | undefined;
  /** CAS: must match current server `profileVersion` when provided. */
  readonly expectedProfileVersion?: number | undefined;
  /** Optional body idempotency key (header `Idempotency-Key` is preferred in HTTP controller). */
  readonly idempotencyKey?: string | undefined;
}

export interface AgentSelfProfileSocketPayload {
  readonly agent_id?: string | undefined;
  readonly name?: string | undefined;
  readonly trade_name?: string | null | undefined;
  readonly document?: string | null | undefined;
  readonly document_type?: AgentDocumentType | null | undefined;
  readonly phone?: string | null | undefined;
  readonly mobile?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly address?:
    | {
        readonly street?: string | null | undefined;
        readonly number?: string | null | undefined;
        readonly district?: string | null | undefined;
        readonly postal_code?: string | null | undefined;
        readonly city?: string | null | undefined;
        readonly state?: string | null | undefined;
      }
    | null
    | undefined;
  readonly notes?: string | null | undefined;
  readonly profile_version?: number | undefined;
  readonly expected_profile_version?: number | undefined;
  readonly idempotency_key?: string | undefined;
}

export interface AgentPulledProfilePayload {
  readonly name: string;
  readonly trade_name?: string;
  readonly document?: string;
  readonly document_type?: AgentDocumentType;
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
}

export interface AgentSelfProfilePatch {
  readonly name?: string;
  readonly tradeName?: string | null;
  readonly document?: string | null;
  readonly documentType?: AgentDocumentType | null;
  readonly phone?: string | null;
  readonly mobile?: string | null;
  readonly email?: string | null;
  readonly address?: AgentAddressPatch | null;
  readonly notes?: string | null;
}

export type AgentProfileUpdateSource = "http" | "socket" | "pull_sync";

export interface PersistAgentProfilePatchInput {
  readonly agentId: string;
  readonly patch: AgentSelfProfilePatch;
  readonly source: AgentProfileUpdateSource;
  readonly profileUpdatedAt?: Date;
  readonly lastLoginUserId?: string;
  /** Monotonic version from agent device (pull_sync only). When set, ordering uses this vs server `profileVersion`. */
  readonly remoteProfileVersion?: number;
  readonly expectedProfileVersion?: number;
  readonly dedupeKey?: string;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
}

export class AgentSelfProfileService {
  constructor(private readonly agentRepository: IAgentRepository) {}

  toPatchFromHttpPayload(payload: AgentSelfProfileHttpPayload): AgentSelfProfilePatch {
    return {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.tradeName !== undefined ? { tradeName: payload.tradeName } : {}),
      ...(payload.document !== undefined ? { document: payload.document } : {}),
      ...(payload.documentType !== undefined ? { documentType: payload.documentType } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
      ...(payload.mobile !== undefined ? { mobile: payload.mobile } : {}),
      ...(payload.email !== undefined ? { email: payload.email } : {}),
      ...(payload.address !== undefined
        ? {
            address:
              payload.address === null
                ? null
                : {
                    ...(payload.address.street !== undefined
                      ? { street: payload.address.street }
                      : {}),
                    ...(payload.address.number !== undefined
                      ? { number: payload.address.number }
                      : {}),
                    ...(payload.address.district !== undefined
                      ? { district: payload.address.district }
                      : {}),
                    ...(payload.address.postalCode !== undefined
                      ? { postalCode: payload.address.postalCode }
                      : {}),
                    ...(payload.address.city !== undefined ? { city: payload.address.city } : {}),
                    ...(payload.address.state !== undefined
                      ? { state: payload.address.state }
                      : {}),
                  },
          }
        : {}),
      ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
    };
  }

  toPatchFromSocketPayload(payload: AgentSelfProfileSocketPayload): AgentSelfProfilePatch {
    return {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.trade_name !== undefined ? { tradeName: payload.trade_name } : {}),
      ...(payload.document !== undefined ? { document: payload.document } : {}),
      ...(payload.document_type !== undefined ? { documentType: payload.document_type } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
      ...(payload.mobile !== undefined ? { mobile: payload.mobile } : {}),
      ...(payload.email !== undefined ? { email: payload.email } : {}),
      ...(payload.address !== undefined
        ? {
            address:
              payload.address === null
                ? null
                : {
                    ...(payload.address.street !== undefined
                      ? { street: payload.address.street }
                      : {}),
                    ...(payload.address.number !== undefined
                      ? { number: payload.address.number }
                      : {}),
                    ...(payload.address.district !== undefined
                      ? { district: payload.address.district }
                      : {}),
                    ...(payload.address.postal_code !== undefined
                      ? { postalCode: payload.address.postal_code }
                      : {}),
                    ...(payload.address.city !== undefined ? { city: payload.address.city } : {}),
                    ...(payload.address.state !== undefined
                      ? { state: payload.address.state }
                      : {}),
                  },
          }
        : {}),
      ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
    };
  }

  toPatchFromPulledProfile(payload: AgentPulledProfilePayload): AgentSelfProfilePatch {
    return {
      name: payload.name,
      ...(payload.trade_name !== undefined ? { tradeName: payload.trade_name } : {}),
      ...(payload.document !== undefined ? { document: payload.document } : {}),
      ...(payload.document_type !== undefined ? { documentType: payload.document_type } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
      ...(payload.mobile !== undefined ? { mobile: payload.mobile } : {}),
      ...(payload.email !== undefined ? { email: payload.email } : {}),
      ...(payload.address !== undefined
        ? {
            address: {
              ...(payload.address.street !== undefined ? { street: payload.address.street } : {}),
              ...(payload.address.number !== undefined ? { number: payload.address.number } : {}),
              ...(payload.address.district !== undefined
                ? { district: payload.address.district }
                : {}),
              ...(payload.address.postal_code !== undefined
                ? { postalCode: payload.address.postal_code }
                : {}),
              ...(payload.address.city !== undefined ? { city: payload.address.city } : {}),
              ...(payload.address.state !== undefined ? { state: payload.address.state } : {}),
            },
          }
        : {}),
      ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
    };
  }

  async persistProfilePatch(input: PersistAgentProfilePatchInput): Promise<Agent> {
    this.assertPatchTaxDocumentValid(input.patch);
    const existing = await this.agentRepository.findById(input.agentId);
    const patchFingerprint = fingerprintAgentProfilePatch(input.patch);
    const changedFields = describeUpdatedFields(input.patch);

    if (
      input.source !== "pull_sync" &&
      input.expectedProfileVersion === undefined &&
      existing !== null
    ) {
      agentProfileReliabilityMetrics.profileWritesLegacyNoExpectedVersionTotal += 1;
    }

    if (input.expectedProfileVersion !== undefined && existing !== null) {
      if (input.expectedProfileVersion !== existing.profileVersion) {
        agentProfileReliabilityMetrics.profileWritesConflictTotal += 1;
        throw conflict("expectedProfileVersion does not match current agent profile version");
      }
    }

    if (
      input.source === "pull_sync" &&
      input.remoteProfileVersion !== undefined &&
      existing !== null
    ) {
      if (input.remoteProfileVersion < existing.profileVersion) {
        agentProfileReliabilityMetrics.profileWritesSkippedStaleRemoteVersionTotal += 1;
        logger.warn("agent_profile_update_skipped_stale_remote_version", {
          agentId: input.agentId,
          remoteProfileVersion: input.remoteProfileVersion,
          currentProfileVersion: existing.profileVersion,
        });
        return existing;
      }
      if (input.remoteProfileVersion === existing.profileVersion) {
        const candidate = this.agentWithStoredDocumentNormalized(
          existing.update({
            ...input.patch,
            ...(existing.profileUpdatedAt !== undefined
              ? { profileUpdatedAt: existing.profileUpdatedAt }
              : {}),
            profileVersion: existing.profileVersion,
          }),
        );
        if (agentsProfileCatalogContentEqual(existing, candidate)) {
          return existing;
        }
        agentProfileReliabilityMetrics.profileWritesPullSyncVersionContentConflictTotal += 1;
        agentProfileReliabilityMetrics.profileWritesConflictTotal += 1;
        logger.warn("agent_profile_pull_sync_version_content_mismatch", {
          agentId: input.agentId,
          profileVersion: existing.profileVersion,
        });
        throw conflict(
          "pull_sync profile_version matches server but profile content differs; resolve split-brain before retrying",
        );
      }
    }

    if (
      input.source === "pull_sync" &&
      input.remoteProfileVersion === undefined &&
      input.profileUpdatedAt === undefined &&
      existing?.profileUpdatedAt !== undefined
    ) {
      agentProfileReliabilityMetrics.profileWritesSkippedMissingTimestampTotal += 1;
      logger.warn("agent_profile_update_skipped_missing_timestamp", {
        agentId: input.agentId,
        source: input.source,
        currentProfileUpdatedAt: existing.profileUpdatedAt.toISOString(),
      });
      return existing;
    }

    const effectiveProfileUpdatedAt =
      input.profileUpdatedAt ??
      (input.source === "pull_sync" ? existing?.profileUpdatedAt : undefined) ??
      new Date();

    if (
      input.source === "pull_sync" &&
      input.remoteProfileVersion === undefined &&
      existing?.profileUpdatedAt !== undefined &&
      input.profileUpdatedAt !== undefined &&
      effectiveProfileUpdatedAt.getTime() < existing.profileUpdatedAt.getTime()
    ) {
      agentProfileReliabilityMetrics.profileWritesSkippedStaleTimestampTotal += 1;
      logger.warn("agent_profile_update_skipped_stale", {
        agentId: input.agentId,
        source: input.source,
        incomingProfileUpdatedAt: effectiveProfileUpdatedAt.toISOString(),
        currentProfileUpdatedAt: existing.profileUpdatedAt.toISOString(),
      });
      return existing;
    }

    let nextProfileVersion: number;
    if (input.source === "pull_sync" && input.remoteProfileVersion !== undefined) {
      nextProfileVersion = input.remoteProfileVersion;
    } else if (!existing) {
      nextProfileVersion = 1;
    } else {
      nextProfileVersion = existing.profileVersion + 1;
    }

    if (!existing) {
      const created = this.agentWithStoredDocumentNormalized(
        this.createAgentFromPatch(input, effectiveProfileUpdatedAt, nextProfileVersion),
      );
      const commit = await this.agentRepository.commitAgentProfileChange({
        mode: "create",
        previousProfileVersion: 0,
        nextAgent: created,
        source: input.source,
        ...(input.lastLoginUserId !== undefined ? { actorUserId: input.lastLoginUserId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
        patchFingerprint,
        changedFields,
        snapshotJson: agentToProfileSnapshotRecord(created),
      });
      if (commit.status === "conflict") {
        agentProfileReliabilityMetrics.profileWritesConflictTotal += 1;
        if (commit.reason === "document_not_unique") {
          logger.warn("agent_profile_document_conflict", {
            agentId: input.agentId,
            source: input.source,
            reason: "document_not_unique",
          });
          throw agentDocumentConflict();
        }
        throw conflict(commit.message);
      }
      if (commit.status === "idempotent") {
        agentProfileReliabilityMetrics.profileWritesIdempotentTotal += 1;
        return commit.agent;
      }
      agentProfileReliabilityMetrics.profileWritesCommittedTotal += 1;
      logger.info("agent_profile_update_persisted", {
        agentId: commit.agent.agentId,
        source: input.source,
        mode: "created",
        profileVersion: commit.agent.profileVersion,
        updatedFields: changedFields,
      });
      this.emitBroadcastIfNeeded(commit.agent, input.source, changedFields);
      return commit.agent;
    }

    const nextAgent = this.agentWithStoredDocumentNormalized(
      existing.update({
        ...input.patch,
        profileUpdatedAt: effectiveProfileUpdatedAt,
        ...(input.lastLoginUserId !== undefined ? { lastLoginUserId: input.lastLoginUserId } : {}),
        profileVersion: nextProfileVersion,
      }),
    );

    const commit = await this.agentRepository.commitAgentProfileChange({
      mode: "update",
      previousProfileVersion: existing.profileVersion,
      nextAgent,
      source: input.source,
      ...(input.lastLoginUserId !== undefined ? { actorUserId: input.lastLoginUserId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
      patchFingerprint,
      changedFields,
      snapshotJson: agentToProfileSnapshotRecord(nextAgent),
    });

    if (commit.status === "conflict") {
      agentProfileReliabilityMetrics.profileWritesConflictTotal += 1;
      if (commit.reason === "document_not_unique") {
        logger.warn("agent_profile_document_conflict", {
          agentId: input.agentId,
          source: input.source,
          reason: "document_not_unique",
        });
        throw agentDocumentConflict();
      }
      throw conflict(commit.message);
    }
    if (commit.status === "idempotent") {
      agentProfileReliabilityMetrics.profileWritesIdempotentTotal += 1;
      return commit.agent;
    }
    agentProfileReliabilityMetrics.profileWritesCommittedTotal += 1;
    logger.info("agent_profile_update_persisted", {
      agentId: commit.agent.agentId,
      source: input.source,
      mode: "updated",
      profileVersion: commit.agent.profileVersion,
      updatedFields: changedFields,
    });
    this.emitBroadcastIfNeeded(commit.agent, input.source, changedFields);
    return commit.agent;
  }

  private assertPatchTaxDocumentValid(patch: AgentSelfProfilePatch): void {
    if (patch.document === undefined) {
      return;
    }
    assertSubmittedAgentProfileDocumentValid(patch.document);
  }

  /**
   * Persists CPF/CNPJ as digits-only (DB unique key) so formatted inputs do not create false duplicates.
   */
  private agentWithStoredDocumentNormalized(agent: Agent): Agent {
    if (agent.document === undefined) {
      return agent;
    }
    const normalized = normalizeAgentDocumentForStorage(agent.document);
    if (normalized === agent.document) {
      return agent;
    }
    if (normalized === undefined) {
      return agent.update({ document: null });
    }
    return agent.update({ document: normalized });
  }

  private emitBroadcastIfNeeded(
    agent: Agent,
    source: AgentProfileUpdateSource,
    changedFields: readonly string[],
  ): void {
    void emitAgentProfileBroadcastEvent({
      agentId: agent.agentId,
      profileVersion: agent.profileVersion,
      profileUpdatedAt: agent.profileUpdatedAt?.toISOString() ?? null,
      source,
      changedFields,
    })
      .then(() => {
        agentProfileReliabilityMetrics.profileBroadcastEmittedTotal += 1;
      })
      .catch(() => {
        agentProfileReliabilityMetrics.profileBroadcastFailedTotal += 1;
      });
  }

  async requireAgent(agentId: string): Promise<Agent> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      throw agentNotFound(agentId);
    }
    return agent;
  }

  private createAgentFromPatch(
    input: PersistAgentProfilePatchInput,
    profileUpdatedAt: Date,
    profileVersion: number,
  ): Agent {
    const name = input.patch.name?.trim();
    if (!name) {
      throw badRequest("Agent profile name is required when creating a new catalog record");
    }

    return Agent.create({
      agentId: input.agentId,
      name,
      profileVersion,
      ...(input.patch.tradeName !== undefined && input.patch.tradeName !== null
        ? { tradeName: input.patch.tradeName }
        : {}),
      ...(input.patch.document !== undefined && input.patch.document !== null
        ? { document: input.patch.document }
        : {}),
      ...(input.patch.documentType !== undefined && input.patch.documentType !== null
        ? { documentType: input.patch.documentType }
        : {}),
      ...(input.patch.phone !== undefined && input.patch.phone !== null
        ? { phone: input.patch.phone }
        : {}),
      ...(input.patch.mobile !== undefined && input.patch.mobile !== null
        ? { mobile: input.patch.mobile }
        : {}),
      ...(input.patch.email !== undefined && input.patch.email !== null
        ? { email: input.patch.email }
        : {}),
      ...(input.patch.address !== undefined && input.patch.address !== null
        ? {
            address: {
              ...(input.patch.address.street !== undefined && input.patch.address.street !== null
                ? { street: input.patch.address.street }
                : {}),
              ...(input.patch.address.number !== undefined && input.patch.address.number !== null
                ? { number: input.patch.address.number }
                : {}),
              ...(input.patch.address.district !== undefined &&
              input.patch.address.district !== null
                ? { district: input.patch.address.district }
                : {}),
              ...(input.patch.address.postalCode !== undefined &&
              input.patch.address.postalCode !== null
                ? { postalCode: input.patch.address.postalCode }
                : {}),
              ...(input.patch.address.city !== undefined && input.patch.address.city !== null
                ? { city: input.patch.address.city }
                : {}),
              ...(input.patch.address.state !== undefined && input.patch.address.state !== null
                ? { state: input.patch.address.state }
                : {}),
            },
          }
        : {}),
      ...(input.patch.notes !== undefined && input.patch.notes !== null
        ? { notes: input.patch.notes }
        : {}),
      profileUpdatedAt,
      ...(input.lastLoginUserId !== undefined ? { lastLoginUserId: input.lastLoginUserId } : {}),
    });
  }
}

const describeUpdatedFields = (patch: AgentSelfProfilePatch): readonly string[] => {
  const fields: string[] = [];
  if (patch.name !== undefined) fields.push("name");
  if (patch.tradeName !== undefined) fields.push("tradeName");
  if (patch.document !== undefined) fields.push("document");
  if (patch.documentType !== undefined) fields.push("documentType");
  if (patch.phone !== undefined) fields.push("phone");
  if (patch.mobile !== undefined) fields.push("mobile");
  if (patch.email !== undefined) fields.push("email");
  if (patch.notes !== undefined) fields.push("notes");
  if (patch.address !== undefined) {
    if (patch.address === null) {
      fields.push("address");
    } else {
      if (patch.address.street !== undefined) fields.push("address.street");
      if (patch.address.number !== undefined) fields.push("address.number");
      if (patch.address.district !== undefined) fields.push("address.district");
      if (patch.address.postalCode !== undefined) fields.push("address.postalCode");
      if (patch.address.city !== undefined) fields.push("address.city");
      if (patch.address.state !== undefined) fields.push("address.state");
    }
  }
  return fields;
};
