import { z } from "zod";

import { env } from "../../shared/config/env";
import {
  noteAgentAutoUpdateDiagnosticsAccepted,
  noteAgentAutoUpdateDiagnosticsPersistFailed,
  noteAgentAutoUpdateDiagnosticsRateLimitedDrop,
  noteAgentAutoUpdateDiagnosticsReceived,
  noteAgentAutoUpdateDiagnosticsValidationDrop,
} from "../../shared/metrics/socket_agent.metrics";
import { logger } from "../../shared/utils/logger";
import { isRecord } from "../../shared/utils/rpc_types";

export const AGENT_AUTO_UPDATE_DIAGNOSTICS_METHOD = "agent.autoUpdate.diagnostics.push" as const;
export const AGENT_AUTO_UPDATE_DIAGNOSTICS_ERROR_MESSAGE_MAX_CHARS = 1_024;

const updateCheckCompletionSourceSchema = z.enum([
  "updateAvailable",
  "updateNotAvailable",
  "updaterError",
  "triggerFailure",
  "triggerTimeout",
  "completionTimeout",
  "notInitialized",
  "circuitOpen",
  "automaticDisabled",
  "automaticInstallStarted",
  "automaticInstallFailure",
  "automaticDownloadFailure",
  "automaticValidationFailure",
  "automaticPendingCompleted",
  "automaticPendingFailed",
  "automaticCooldown",
  "automaticRolloutSkipped",
  "automaticCancelled",
  "automaticQuietHours",
]);

const nullableOptional = <T extends z.ZodTypeAny>(schema: T): z.ZodNullable<T> =>
  schema.nullable();

const isoDateTimeStringSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "checkedAt must be an ISO-8601 date-time string",
});

const autoUpdateDiagnosticsParamsSchema = z
  .object({
    agentId: z.string().min(1).max(128),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+(?:\+\d+)?$/u),
    checkId: nullableOptional(z.string()).optional(),
    checkedAt: isoDateTimeStringSchema,
    source: z.enum(["manual", "background", "silent", "reconcile"]),
    completionSource: nullableOptional(updateCheckCompletionSourceSchema).optional(),
    remoteVersion: nullableOptional(z.string()).optional(),
    updateAvailable: nullableOptional(z.boolean()).optional(),
    channel: nullableOptional(z.enum(["stable", "beta", "internal"])).optional(),
    rolloutBucket: nullableOptional(z.number().int().min(0).max(99)).optional(),
    feedSignatureStatus: nullableOptional(
      z.enum(["valid", "invalid", "missing", "malformed", "publicKeyUnavailable"]),
    ).optional(),
    feedSignatureRequired: nullableOptional(z.boolean()).optional(),
    helperSignatureStatus: nullableOptional(
      z.enum(["valid", "invalid", "unsigned", "unknown"]),
    ).optional(),
    probeDurationMs: nullableOptional(z.number().int().min(0)).optional(),
    downloadDurationMs: nullableOptional(z.number().int().min(0)).optional(),
    automaticFailureCount: nullableOptional(z.number().int().min(0)).optional(),
    errorMessage: nullableOptional(z.string()).optional(),
  })
  .strict();

type AutoUpdateDiagnosticsParams = z.infer<typeof autoUpdateDiagnosticsParamsSchema>;
type NullableParam<T> = Exclude<T, undefined> | null;

export interface StoredAgentAutoUpdateDiagnostics {
  readonly agentId: string;
  readonly appVersion: string;
  readonly checkId: string | null;
  readonly checkedAt: Date;
  readonly source: AutoUpdateDiagnosticsParams["source"];
  readonly completionSource: NullableParam<AutoUpdateDiagnosticsParams["completionSource"]>;
  readonly remoteVersion: string | null;
  readonly updateAvailable: boolean | null;
  readonly channel: NullableParam<AutoUpdateDiagnosticsParams["channel"]>;
  readonly rolloutBucket: number | null;
  readonly feedSignatureStatus: NullableParam<
    AutoUpdateDiagnosticsParams["feedSignatureStatus"]
  >;
  readonly feedSignatureRequired: boolean | null;
  readonly helperSignatureStatus: NullableParam<
    AutoUpdateDiagnosticsParams["helperSignatureStatus"]
  >;
  readonly probeDurationMs: number | null;
  readonly downloadDurationMs: number | null;
  readonly automaticFailureCount: number | null;
  readonly errorMessage: string | null;
}

export interface AgentAutoUpdateDiagnosticsRepository {
  create(record: StoredAgentAutoUpdateDiagnostics): Promise<void>;
  findRecentByAgentId(
    agentId: string,
    limit: number,
  ): Promise<readonly StoredAgentAutoUpdateDiagnostics[]>;
  pruneBefore(cutoff: Date, batchSize: number): Promise<number>;
}

export type AgentAutoUpdateDiagnosticsIngestStatus =
  | "accepted"
  | "disabled"
  | "validation_drop"
  | "rate_limited_drop"
  | "persist_failed";

export interface AgentAutoUpdateDiagnosticsIngestResult {
  readonly status: AgentAutoUpdateDiagnosticsIngestStatus;
  readonly reason?: string;
}

interface AgentAutoUpdateDiagnosticsServiceOptions {
  readonly now?: () => number;
}

interface AgentAutoUpdateDiagnosticsIngestInput {
  readonly authenticatedAgentId: string;
  readonly socketId: string;
  readonly notification: unknown;
  readonly messageBytes?: number | null;
}

interface RateLimitWindow {
  readonly windowStartedAtMs: number;
  acceptedCount: number;
}

interface RateLimitReservation {
  readonly windowStartedAtMs: number | null;
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const jsonByteLength = (value: unknown): number | null => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
};

const truncateErrorMessage = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return value.length > AGENT_AUTO_UPDATE_DIAGNOSTICS_ERROR_MESSAGE_MAX_CHARS
    ? value.slice(0, AGENT_AUTO_UPDATE_DIAGNOSTICS_ERROR_MESSAGE_MAX_CHARS)
    : value;
};

const toStoredDiagnostics = (
  params: AutoUpdateDiagnosticsParams,
): StoredAgentAutoUpdateDiagnostics => ({
  agentId: params.agentId,
  appVersion: params.appVersion,
  checkId: params.checkId ?? null,
  checkedAt: new Date(params.checkedAt),
  source: params.source,
  completionSource: params.completionSource ?? null,
  remoteVersion: params.remoteVersion ?? null,
  updateAvailable: params.updateAvailable ?? null,
  channel: params.channel ?? null,
  rolloutBucket: params.rolloutBucket ?? null,
  feedSignatureStatus: params.feedSignatureStatus ?? null,
  feedSignatureRequired: params.feedSignatureRequired ?? null,
  helperSignatureStatus: params.helperSignatureStatus ?? null,
  probeDurationMs: params.probeDurationMs ?? null,
  downloadDurationMs: params.downloadDurationMs ?? null,
  automaticFailureCount: params.automaticFailureCount ?? null,
  errorMessage: truncateErrorMessage(params.errorMessage),
});

export class AgentAutoUpdateDiagnosticsService {
  private readonly rateLimitWindowsByAgentId = new Map<string, RateLimitWindow>();
  private readonly now: () => number;

  constructor(
    private readonly repository: AgentAutoUpdateDiagnosticsRepository,
    options: AgentAutoUpdateDiagnosticsServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async ingestNotification(
    input: AgentAutoUpdateDiagnosticsIngestInput,
  ): Promise<AgentAutoUpdateDiagnosticsIngestResult> {
    noteAgentAutoUpdateDiagnosticsReceived();

    if (!env.agentAutoUpdateDiagnosticsEnabled) {
      return { status: "disabled" };
    }

    const messageBytes = input.messageBytes ?? jsonByteLength(input.notification);
    if (
      messageBytes !== null &&
      messageBytes > env.agentAutoUpdateDiagnosticsMaxMessageBytes
    ) {
      return this.validationDrop("message_too_large", input);
    }

    const notification = input.notification;
    if (!isRecord(notification)) {
      return this.validationDrop("notification must be an object", input);
    }
    if (notification.jsonrpc !== "2.0") {
      return this.validationDrop("jsonrpc must be 2.0", input);
    }
    if (notification.method !== AGENT_AUTO_UPDATE_DIAGNOSTICS_METHOD) {
      return this.validationDrop("unsupported agent-to-hub rpc method", input);
    }
    if (hasOwn(notification, "id")) {
      return this.validationDrop("diagnostics push must be a JSON-RPC notification without id", input);
    }
    if (!hasOwn(notification, "params")) {
      return this.validationDrop("params is required", input);
    }

    const payloadBytes = jsonByteLength(notification.params);
    if (
      payloadBytes !== null &&
      payloadBytes > env.agentAutoUpdateDiagnosticsMaxPayloadBytes
    ) {
      return this.validationDrop("payload_too_large", input);
    }

    const parsed = autoUpdateDiagnosticsParamsSchema.safeParse(notification.params);
    if (!parsed.success) {
      return this.validationDrop(parsed.error.issues[0]?.message ?? "invalid params", input);
    }

    if (parsed.data.agentId !== input.authenticatedAgentId) {
      return this.validationDrop("agentId does not match authenticated socket agent", input);
    }

    const nowMs = this.now();
    const rateLimitReservation = this.tryReserveRateLimit(input.authenticatedAgentId, nowMs);
    if (rateLimitReservation === null) {
      noteAgentAutoUpdateDiagnosticsRateLimitedDrop();
      return { status: "rate_limited_drop" };
    }

    try {
      await this.repository.create(toStoredDiagnostics(parsed.data));
      noteAgentAutoUpdateDiagnosticsAccepted();
      return { status: "accepted" };
    } catch (error: unknown) {
      this.rollbackRateLimitReservation(input.authenticatedAgentId, rateLimitReservation);
      noteAgentAutoUpdateDiagnosticsPersistFailed();
      logger.warn("agent_auto_update_diagnostics_persist_failed", {
        socketId: input.socketId,
        agentId: input.authenticatedAgentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { status: "persist_failed" };
    }
  }

  resetForTests(): void {
    this.rateLimitWindowsByAgentId.clear();
  }

  async pruneOlderThanDays(options?: {
    readonly retentionDays?: number;
    readonly batchSize?: number;
  }): Promise<number> {
    const retentionDays = Math.max(
      1,
      Math.floor(options?.retentionDays ?? env.agentAutoUpdateDiagnosticsRetentionDays),
    );
    const batchSize = Math.max(
      1,
      Math.floor(options?.batchSize ?? env.agentAutoUpdateDiagnosticsPruneBatchSize),
    );
    const cutoff = new Date(this.now() - retentionDays * 24 * 60 * 60 * 1000);
    let totalDeleted = 0;
    while (true) {
      const deleted = await this.repository.pruneBefore(cutoff, batchSize);
      totalDeleted += deleted;
      if (deleted < batchSize) {
        return totalDeleted;
      }
    }
  }

  private validationDrop(
    reason: string,
    input: AgentAutoUpdateDiagnosticsIngestInput,
  ): AgentAutoUpdateDiagnosticsIngestResult {
    noteAgentAutoUpdateDiagnosticsValidationDrop();
    logger.warn("agent_auto_update_diagnostics_validation_drop", {
      socketId: input.socketId,
      agentId: input.authenticatedAgentId,
      reason,
    });
    return { status: "validation_drop", reason };
  }

  private tryReserveRateLimit(
    agentId: string,
    nowMs: number,
  ): RateLimitReservation | null {
    const maxAcceptedPerWindow = Math.floor(env.agentAutoUpdateDiagnosticsRateLimitMax);
    if (maxAcceptedPerWindow <= 0) {
      return { windowStartedAtMs: null };
    }

    const windowMs = Math.max(1, Math.floor(env.agentAutoUpdateDiagnosticsRateLimitWindowMs));
    const current = this.rateLimitWindowsByAgentId.get(agentId);
    if (!current || nowMs - current.windowStartedAtMs >= windowMs) {
      this.rateLimitWindowsByAgentId.set(agentId, {
        windowStartedAtMs: nowMs,
        acceptedCount: 1,
      });
      return { windowStartedAtMs: nowMs };
    }

    if (current.acceptedCount >= maxAcceptedPerWindow) {
      return null;
    }

    current.acceptedCount += 1;
    return { windowStartedAtMs: current.windowStartedAtMs };
  }

  private rollbackRateLimitReservation(
    agentId: string,
    reservation: RateLimitReservation,
  ): void {
    if (reservation.windowStartedAtMs === null) {
      return;
    }
    const current = this.rateLimitWindowsByAgentId.get(agentId);
    if (!current || current.windowStartedAtMs !== reservation.windowStartedAtMs) {
      return;
    }
    current.acceptedCount -= 1;
    if (current.acceptedCount <= 0) {
      this.rateLimitWindowsByAgentId.delete(agentId);
    }
  }
}
