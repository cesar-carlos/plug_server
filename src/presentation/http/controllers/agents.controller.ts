import type { NextFunction, Request, Response } from "express";

import { executeAuthorizedAgentCommand } from "../../../application/agent_commands/execute_authorized_agent_command";
import { createBridgeLatencyTraceForRequest } from "../../../application/services/bridge_latency_trace_builder";
import { buildServerTimingsEnvelope } from "../../../application/services/server_timings_envelope";
import { noteServerTimingsOptIn } from "../../../shared/metrics/socket_consumer.metrics";
import {
  incrementRestBridgeRequest,
  incrementRestBridgeRequestFailed,
  incrementRestBridgeRequestSuccess,
  observeRestBridgeLatency,
} from "../../../application/services/rest_bridge_metrics.service";
import { AgentDisconnectedBeforeDispatchError } from "../../../shared/errors/agent_disconnected_before_dispatch.error";
import { AppError } from "../../../shared/errors/app_error";
import { forbidden, serviceUnavailable } from "../../../shared/errors/http_errors";
import { buildAgentOfflineNormalizedResponse } from "../serializers/agent_offline_bridge_response";
import { normalizeAgentRpcResponse } from "../serializers/agent_rpc_response.serializer";
import { resolveAgentRpcRetryAfterSeconds } from "../serializers/agent_rpc_retry_after";
import {
  toPublicConnectedAgents,
  type PublicConnectedAgent,
} from "../serializers/agent_registry.serializer";
import { buildWeakETag, sendIfNoneMatch } from "../helpers/weak_etag";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import { toCorrelationIds } from "../../../shared/utils/bridge_command_correlation";
import type { AgentCommandBody, ListConnectedAgentsQuery } from "../validators/agents.validator";
import type {
  AgentSelfProfileHttpBody,
  AgentSelfProfileParams,
} from "../validators/agent_self_profile.validator";
import { env } from "../../../shared/config/env";
import { container } from "../../../shared/di/container";
import {
  isJwtAdmin,
  resolveVisibleAgentIds,
} from "../../../application/policies/agent_visibility.policy";
import type { AgentAccessPrincipal } from "../../../application/services/agent_access.service";
import { toAgentCatalogDto } from "../serializers/agent_catalog.serializer";
import { logger } from "../../../shared/utils/logger";

const resolveAgentAccessPrincipal = (
  sub: string,
  principalType?: string,
  role?: string,
): AgentAccessPrincipal =>
  principalType === "client"
    ? { type: "client", id: sub }
    : { type: "user", id: sub, ...(role !== undefined ? { role } : {}) };

const hasConnectedAgentsPagination = (query: ListConnectedAgentsQuery): boolean =>
  query.page !== undefined || query.pageSize !== undefined;

export const listConnectedAgents = async (request: Request, response: Response): Promise<void> => {
  const authUser = getAuthUser(response);
  const query = getValidated<ListConnectedAgentsQuery>(response, "query");

  const visibleAgentIds = await resolveVisibleAgentIds(authUser, (userId) =>
    container.userAgentService.listAgentIdsByUserId(userId),
  );

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.max(1, Math.min(100, query.pageSize ?? 20));

  const allowedIdSet = visibleAgentIds !== undefined ? new Set(visibleAgentIds) : undefined;

  const { items, total } = hasConnectedAgentsPagination(query)
    ? container.restAgentBridgeService.listConnectedAgentsPaged({
        ...(allowedIdSet !== undefined ? { allowedIds: allowedIdSet } : {}),
        page,
        pageSize,
      })
    : (() => {
        let all = container.restAgentBridgeService.listConnectedAgents();
        if (allowedIdSet !== undefined) {
          all = all.filter((a) => allowedIdSet.has(a.agentId));
        }
        return { items: all, total: all.length };
      })();

  const publicAgents: PublicConnectedAgent[] = toPublicConnectedAgents(items);

  const payload: {
    agents: PublicConnectedAgent[];
    count: number;
    total?: number;
    page?: number;
    pageSize?: number;
    _diagnostic?: { socketConnectionsInAgentsNamespace: number };
  } = {
    agents: publicAgents,
    count: publicAgents.length,
    ...(hasConnectedAgentsPagination(query) ? { total, page, pageSize } : {}),
  };

  if (isJwtAdmin(authUser) && env.nodeEnv !== "production") {
    const socketConnectionsInAgentsNamespace =
      container.restAgentBridgeService.getAgentsNamespaceConnectionCount();
    if (socketConnectionsInAgentsNamespace !== undefined) {
      payload._diagnostic = {
        socketConnectionsInAgentsNamespace,
      };
    }
  }

  /**
   * In-memory registry data changes more frequently than the catalog, but
   * during a polling burst (UI auto-refresh) consecutive payloads are usually
   * identical, so the 304 short-circuit still pays off.
   */
  const etag = buildWeakETag(payload);
  if (sendIfNoneMatch(request, response, etag)) {
    return;
  }
  response.status(200).json(payload);
};

export const patchMyAgentProfile = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { agentId } = getValidated<AgentSelfProfileParams>(response, "params");
  const body = getValidated<AgentSelfProfileHttpBody>(response, "body");
  const tokenAgentId = authUser.agent_id;

  if (authUser.role !== "agent" || typeof tokenAgentId !== "string" || tokenAgentId.trim() === "") {
    logger.warn("agent_self_profile_http_token_missing_agent_claim", {
      userId: authUser.sub,
      role: authUser.role,
      pathAgentId: agentId,
    });
    next(forbidden("Agent token with agent_id claim is required"));
    return;
  }

  if (tokenAgentId !== agentId) {
    logger.warn("agent_self_profile_http_identity_mismatch", {
      userId: authUser.sub,
      tokenAgentId,
      pathAgentId: agentId,
    });
    next(forbidden("Authenticated agent cannot update another agent profile"));
    return;
  }

  const idemHeader = request.get("Idempotency-Key")?.trim();
  const dedupeKey =
    idemHeader !== undefined && idemHeader !== ""
      ? `idem:${idemHeader}`
      : body.idempotencyKey !== undefined && body.idempotencyKey.trim() !== ""
        ? `idem:${body.idempotencyKey.trim()}`
        : undefined;

  const requestId =
    typeof response.locals.requestId === "string" ? response.locals.requestId : undefined;

  let updated: Awaited<ReturnType<typeof container.agentSelfProfileService.persistProfilePatch>>;
  try {
    updated = await container.agentSelfProfileService.persistProfilePatch({
      agentId,
      patch: container.agentSelfProfileService.toPatchFromHttpPayload(body),
      source: "http",
      lastLoginUserId: authUser.sub,
      ...(body.expectedProfileVersion !== undefined
        ? { expectedProfileVersion: body.expectedProfileVersion }
        : {}),
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });
  } catch (error) {
    if (error instanceof AppError) {
      logger.warn("agent_self_profile_http_failed", {
        userId: authUser.sub,
        agentId,
        code: error.code,
        statusCode: error.statusCode,
        message: error.message,
      });
    }
    next(error);
    return;
  }

  logger.info("agent_self_profile_http_updated", {
    userId: authUser.sub,
    agentId,
  });
  response.status(200).json({ agent: toAgentCatalogDto(updated) });
};

export const proxyCommandToAgent = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<AgentCommandBody>(response, "body");
  const authUser = getAuthUser(response);
  const abortController = new AbortController();
  /**
   * `response.once("close", ...)` self-removes after firing, dropping the
   * explicit `response.off(...)` cleanup the previous implementation needed.
   * Fires on both normal completion and premature client disconnect; the
   * `writableEnded` guard ensures we only abort the in-flight agent command
   * when the client disconnected before the response was written.
   */
  response.once("close", () => {
    if (!response.writableEnded && !abortController.signal.aborted) {
      abortController.abort();
    }
  });

  incrementRestBridgeRequest();

  if (body.requestServerTimings === true) {
    noteServerTimingsOptIn("rest");
  }
  // Force-active the trace when the consumer opted into `serverTimings`,
  // even if the global sampling toggle is off; otherwise fall back to the
  // sampled factory so production cost is unchanged for opt-out consumers.
  const latencyTrace = createBridgeLatencyTraceForRequest({
    channel: "rest",
    userId: authUser.sub,
    forceActive: body.requestServerTimings === true,
  });
  const includeServerTimings = body.requestServerTimings === true && latencyTrace !== null;

  const startMs = Date.now();
  try {
    const result = await executeAuthorizedAgentCommand(
      {
        principal: resolveAgentAccessPrincipal(
          authUser.sub,
          authUser.principal_type,
          authUser.role,
        ),
        agentId: body.agentId,
        command: body.command,
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.pagination !== undefined ? { pagination: body.pagination } : {}),
        ...(body.payloadFrameCompression !== undefined
          ? { payloadFrameCompression: body.payloadFrameCompression }
          : {}),
        signal: abortController.signal,
        ...(latencyTrace ? { latencyTrace } : {}),
      },
      container.agentAccessService,
      container.restAgentBridgeService.getDispatchCommand(),
      normalizeAgentRpcResponse,
    );

    if ("notification" in result && result.notification) {
      incrementRestBridgeRequestSuccess();
      observeRestBridgeLatency(Date.now() - startMs);
      const tWrite = performance.now();
      response.status(202).json({
        mode: "bridge",
        agentId: body.agentId,
        requestId: result.requestId,
        notification: true,
        acceptedCommands: result.acceptedCommands,
        ...(includeServerTimings
          ? { serverTimings: buildServerTimingsEnvelope(latencyTrace!) }
          : {}),
      });
      latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWrite);
      latencyTrace?.finalizeOnce({ outcome: "notification", httpStatus: 202 });
      return;
    }
    if (!("response" in result)) {
      throw new Error("Invalid command result: missing response payload");
    }

    incrementRestBridgeRequestSuccess();
    observeRestBridgeLatency(Date.now() - startMs);
    const tWriteOk = performance.now();
    // Surface agent-side `-32013 / rate_limited` hints (notably from
    // `client_token.getPolicy` per `socket_communication_standard.md` (introduced in profile 2.7) as
    // a standard HTTP `Retry-After` header so REST clients can back off
    // without parsing the JSON-RPC error envelope.
    const retryAfterSeconds = resolveAgentRpcRetryAfterSeconds(result.response);
    if (retryAfterSeconds !== null) {
      response.setHeader("Retry-After", String(retryAfterSeconds));
    }
    response.status(200).json({
      mode: "bridge",
      agentId: body.agentId,
      requestId: result.requestId,
      response: result.response,
      ...(includeServerTimings
        ? { serverTimings: buildServerTimingsEnvelope(latencyTrace!) }
        : {}),
    });
    latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWriteOk);
    latencyTrace?.finalizeOnce({ outcome: "success", httpStatus: 200 });
  } catch (error: unknown) {
    if (error instanceof AgentDisconnectedBeforeDispatchError) {
      if (toCorrelationIds(error.command).length === 0) {
        incrementRestBridgeRequestFailed();
        observeRestBridgeLatency(Date.now() - startMs);
        if (latencyTrace && !latencyTrace.isFinalized()) {
          latencyTrace.finalizeOnce({
            outcome: "error",
            httpStatus: 503,
            errorCode: "SERVICE_UNAVAILABLE",
          });
        }
        next(serviceUnavailable(`Agent ${error.agentId} is disconnected`));
        return;
      }

      incrementRestBridgeRequestSuccess();
      observeRestBridgeLatency(Date.now() - startMs);
      const { requestId, response: offlineRpcEnvelope } = buildAgentOfflineNormalizedResponse(
        error.agentId,
        error.command,
      );
      const tWriteOffline = performance.now();
      response.status(200).json({
        mode: "bridge",
        agentId: error.agentId,
        requestId,
        response: offlineRpcEnvelope,
        ...(includeServerTimings
          ? { serverTimings: buildServerTimingsEnvelope(latencyTrace!) }
          : {}),
      });
      latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWriteOffline);
      latencyTrace?.finalizeOnce({ outcome: "success", httpStatus: 200 });
      return;
    }

    incrementRestBridgeRequestFailed();
    observeRestBridgeLatency(Date.now() - startMs);
    if (latencyTrace && !latencyTrace.isFinalized()) {
      const appErr = error instanceof AppError ? error : null;
      latencyTrace.finalizeOnce({
        outcome: "error",
        httpStatus: appErr?.statusCode ?? 500,
        errorCode: appErr?.code ?? "INTERNAL_ERROR",
      });
    }
    next(error);
  }
};
