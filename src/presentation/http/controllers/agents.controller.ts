import type { NextFunction, Request, Response } from "express";

import { executeAgentCommand } from "../../../application/agent_commands/execute_agent_command";
import { createBridgeLatencyTraceIfSampled } from "../../../application/services/bridge_latency_trace_builder";
import {
  incrementRestBridgeRequest,
  incrementRestBridgeRequestFailed,
  incrementRestBridgeRequestSuccess,
  observeRestBridgeLatency,
} from "../../../application/services/rest_bridge_metrics.service";
import { AppError } from "../../../shared/errors/app_error";
import { notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { agentRegistry } from "../../socket/hub/agent_registry";
import { agentsNamespace } from "../../../socket";
import { dispatchRpcCommandToAgent } from "../../socket/hub/rpc_bridge";
import { normalizeAgentRpcResponse } from "../serializers/agent_rpc_response.serializer";
import { getValidated } from "../middlewares/validate.middleware";
import type { AgentCommandBody } from "../validators/agents.validator";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

export const listConnectedAgents = (_request: Request, response: Response): void => {
  const agents = agentRegistry.listAll();
  const payload: {
    agents: ReturnType<typeof agentRegistry.listAll>;
    count: number;
    _diagnostic?: { socketConnectionsInAgentsNamespace: number };
  } = {
    agents,
    count: agents.length,
  };

  if (env.nodeEnv !== "production" && agentsNamespace) {
    payload._diagnostic = {
      socketConnectionsInAgentsNamespace: agentsNamespace.sockets.size,
    };
  }

  response.status(200).json(payload);
};

export const proxyCommandToAgent = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<AgentCommandBody>(response, "body");
  const abortController = new AbortController();
  const abortOnClientDisconnect = (): void => {
    if (!response.writableEnded && !abortController.signal.aborted) {
      abortController.abort();
    }
  };
  request.on("aborted", abortOnClientDisconnect);
  response.on("close", abortOnClientDisconnect);

  incrementRestBridgeRequest();

  const registeredAgent = agentRegistry.findByAgentId(body.agentId);
  if (!registeredAgent) {
    incrementRestBridgeRequestFailed();
    if (agentRegistry.hasKnownAgentId(body.agentId)) {
      throw serviceUnavailable(`Agent ${body.agentId} is disconnected`);
    }
    throw notFound(`Agent ${body.agentId}`);
  }

  const authUser = response.locals.authUser as JwtAccessPayload | undefined;
  const latencyTrace = createBridgeLatencyTraceIfSampled({
    channel: "rest",
    userId: typeof authUser?.sub === "string" ? authUser.sub : undefined,
  });

  const startMs = Date.now();
  try {
    const result = await executeAgentCommand(
      {
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
      dispatchRpcCommandToAgent,
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
    response.status(200).json({
      mode: "bridge",
      agentId: body.agentId,
      requestId: result.requestId,
      response: result.response,
    });
    latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWriteOk);
    latencyTrace?.finalizeOnce({ outcome: "success", httpStatus: 200 });
  } catch (error: unknown) {
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
  } finally {
    request.off("aborted", abortOnClientDisconnect);
    response.off("close", abortOnClientDisconnect);
  }
};
