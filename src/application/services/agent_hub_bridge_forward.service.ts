import { randomUUID } from "node:crypto";

import type {
  AgentHubPresencePort,
  AgentHubPresenceRoute,
} from "../../domain/ports/agent_hub_presence.port";
import { AgentDisconnectedBeforeDispatchError } from "../../shared/errors/agent_disconnected_before_dispatch.error";
import { AppError } from "../../shared/errors/app_error";
import { notFound, serviceUnavailable } from "../../shared/errors/http_errors";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";
import type { BridgeCommand, PayloadFrameCompression } from "../../shared/validators/agent_command";
import {
  noteBridgeCommandHandled,
  noteBridgeForwardError,
  noteBridgeForwardRequest,
  noteBridgeForwardSuccess,
  noteBridgeForwardTimeout,
} from "./agent_hub_presence_redis_metrics.service";
import type {
  BridgeForwardCommandEnvelope,
  BridgeForwardDispatchResult,
  BridgeForwardReplyPayload,
} from "./agent_hub_bridge_forward.types";

export interface DispatchRpcCommandInput {
  readonly agentId: string;
  readonly command: BridgeCommand;
  readonly timeoutMs?: number | undefined;
  readonly payloadFrameCompression?: PayloadFrameCompression | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type DispatchRpcCommandResult = BridgeForwardDispatchResult;

export interface AgentHubBridgeForwardDeps {
  readonly presence: AgentHubPresencePort;
  readonly isAgentRegisteredLocally: (agentId: string) => boolean;
  readonly hasKnownAgentId: (agentId: string) => boolean;
  readonly localDispatch: (input: DispatchRpcCommandInput) => Promise<DispatchRpcCommandResult>;
  readonly publishCommand: (targetHubInstanceId: string, payload: string) => Promise<boolean>;
  readonly publishReply: (correlationId: string, payload: string) => Promise<boolean>;
  readonly waitForReply: (correlationId: string, timeoutMs: number) => Promise<string>;
  readonly onBridgeCommand: (handler: (message: string) => void) => void;
}

const parseReplyPayload = (raw: string): BridgeForwardReplyPayload | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const payload = parsed as Record<string, unknown>;
    if (payload.kind === "success") {
      const result = payload.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        return null;
      }
      return { kind: "success", result: result as BridgeForwardDispatchResult };
    }
    if (payload.kind === "agent_disconnected" && typeof payload.agentId === "string") {
      return { kind: "agent_disconnected", agentId: payload.agentId };
    }
    if (payload.kind === "error" && typeof payload.message === "string") {
      return {
        kind: "error",
        message: payload.message,
        ...(typeof payload.statusCode === "number" ? { statusCode: payload.statusCode } : {}),
        ...(typeof payload.code === "string" ? { code: payload.code } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
};

const serializeReply = (reply: BridgeForwardReplyPayload): string => JSON.stringify(reply);

const mapReplyToError = (reply: BridgeForwardReplyPayload, command: BridgeCommand): Error => {
  if (reply.kind === "agent_disconnected") {
    return new AgentDisconnectedBeforeDispatchError(reply.agentId, command);
  }
  if (reply.kind === "error") {
    if (reply.statusCode === 404) {
      return notFound(reply.message);
    }
    return new AppError(reply.message, {
      statusCode: reply.statusCode ?? 503,
      code: reply.code ?? "BRIDGE_FORWARD_ERROR",
    });
  }
  return serviceUnavailable("Invalid bridge forward reply");
};

const mapDispatchErrorToReply = (
  error: unknown,
  agentId: string,
  command: BridgeCommand,
  hasKnownAgentId: (id: string) => boolean,
): BridgeForwardReplyPayload => {
  if (error instanceof AgentDisconnectedBeforeDispatchError) {
    return { kind: "agent_disconnected", agentId };
  }
  if (error instanceof AppError) {
    return {
      kind: "error",
      message: error.message,
      statusCode: error.statusCode,
      code: error.code,
    };
  }
  if (error instanceof Error && error.message.includes("not found") && !hasKnownAgentId(agentId)) {
    return { kind: "error", message: error.message, statusCode: 404 };
  }
  void command;
  return {
    kind: "error",
    message: error instanceof Error ? error.message : "Bridge dispatch failed",
    statusCode: 503,
  };
};

export const installBridgeCommandSubscriber = (deps: AgentHubBridgeForwardDeps): void => {
  deps.onBridgeCommand((message) => {
    void handleIncomingBridgeCommand(message, deps);
  });
};

const handleIncomingBridgeCommand = async (
  message: string,
  deps: AgentHubBridgeForwardDeps,
): Promise<void> => {
  let envelope: BridgeForwardCommandEnvelope;
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as BridgeForwardCommandEnvelope).kind !== "bridge_forward_command"
    ) {
      return;
    }
    envelope = parsed as BridgeForwardCommandEnvelope;
  } catch {
    return;
  }

  noteBridgeCommandHandled();
  let reply: BridgeForwardReplyPayload;
  try {
    const result = await deps.localDispatch({
      agentId: envelope.agentId,
      command: envelope.command,
      timeoutMs: envelope.timeoutMs,
      payloadFrameCompression: envelope.payloadFrameCompression,
    });
    reply = { kind: "success", result };
  } catch (error: unknown) {
    reply = mapDispatchErrorToReply(
      error,
      envelope.agentId,
      envelope.command,
      deps.hasKnownAgentId,
    );
  }

  const published = await deps.publishReply(envelope.correlationId, serializeReply(reply));
  if (!published) {
    logger.warn("agent_hub_bridge_reply_publish_failed", {
      correlationId: envelope.correlationId,
      agentId: envelope.agentId,
    });
  }
};

function throwNoRouteForAgent(
  deps: AgentHubBridgeForwardDeps,
  input: DispatchRpcCommandInput,
): never {
  if (deps.hasKnownAgentId(input.agentId)) {
    throw new AgentDisconnectedBeforeDispatchError(input.agentId, input.command);
  }
  throw notFound(`Agent ${input.agentId}`);
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const resolveRouteWithBriefRetry = async (
  presence: AgentHubPresencePort,
  agentId: string,
): Promise<AgentHubPresenceRoute | null> => {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const route = await presence.resolveRoute(agentId);
    if (route !== null) {
      return route;
    }
    if (attempt < attempts - 1) {
      await sleepMs(25);
    }
  }
  return null;
};

const peerHubInstanceIds = (localHubId: string): readonly string[] =>
  env.agentHubClusterInstanceIds.filter((hubInstanceId) => hubInstanceId !== localHubId);

const isPeerForwardRetryable = (error: unknown): boolean => {
  if (error instanceof AgentDisconnectedBeforeDispatchError) {
    return false;
  }
  if (error instanceof AppError) {
    return error.statusCode === 404;
  }
  return error instanceof Error && error.message.includes("timed out");
};

export const createDispatchOrForwardRpcCommand = (
  deps: AgentHubBridgeForwardDeps,
): ((input: DispatchRpcCommandInput) => Promise<DispatchRpcCommandResult>) => {
  const forwardToHub = async (
    input: DispatchRpcCommandInput,
    route: AgentHubPresenceRoute,
  ): Promise<DispatchRpcCommandResult> => {
    const correlationId = randomUUID();
    const envelope: BridgeForwardCommandEnvelope = {
      kind: "bridge_forward_command",
      correlationId,
      agentId: input.agentId,
      command: input.command,
      timeoutMs: input.timeoutMs,
      payloadFrameCompression: input.payloadFrameCompression,
    };

    const forwardTimeoutMs = Math.max(
      env.agentHubBridgeForwardTimeoutMs,
      input.timeoutMs ?? env.agentHubBridgeForwardTimeoutMs,
    );

    noteBridgeForwardRequest();
    // Subscribe for the reply before publishing the command so a fast owner response
    // cannot arrive before the subscriber is active.
    const rawReplyPromise = deps.waitForReply(correlationId, forwardTimeoutMs);
    const published = await deps.publishCommand(route.hubInstanceId, JSON.stringify(envelope));
    if (!published) {
      noteBridgeForwardError();
      throw serviceUnavailable("Bridge forward publish unavailable");
    }

    try {
      const rawReply = await rawReplyPromise;
      const reply = parseReplyPayload(rawReply);
      if (reply === null) {
        noteBridgeForwardError();
        throw serviceUnavailable("Invalid bridge forward reply");
      }
      if (reply.kind === "success") {
        noteBridgeForwardSuccess();
        return reply.result;
      }
      noteBridgeForwardError();
      throw mapReplyToError(reply, input.command);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("timed out")) {
        noteBridgeForwardTimeout();
      } else if (!(error instanceof AgentDisconnectedBeforeDispatchError) && !(error instanceof AppError)) {
        noteBridgeForwardError();
      }
      throw error;
    }
  };

  const forwardToPeerHubs = async (
    input: DispatchRpcCommandInput,
    localHubId: string,
  ): Promise<DispatchRpcCommandResult | null> => {
    const peers = peerHubInstanceIds(localHubId);
    if (peers.length === 0) {
      return null;
    }

    let lastError: unknown;
    for (const peerHubId of peers) {
      try {
        return await forwardToHub(input, { hubInstanceId: peerHubId });
      } catch (error: unknown) {
        lastError = error;
        if (!isPeerForwardRetryable(error)) {
          throw error;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    return null;
  };

  const forwardViaPresenceOrPeers = async (
    input: DispatchRpcCommandInput,
    localHubId: string,
  ): Promise<DispatchRpcCommandResult> => {
    let route = await deps.presence.resolveRoute(input.agentId);

    if (route !== null && localHubId !== "" && route.hubInstanceId === localHubId) {
      await deps.presence.removeIfHubInstanceMatches(input.agentId, localHubId);
      route = await resolveRouteWithBriefRetry(deps.presence, input.agentId);
    }

    if (route !== null && (localHubId === "" || route.hubInstanceId !== localHubId)) {
      try {
        return await forwardToHub(input, route);
      } catch (error: unknown) {
        if (!isPeerForwardRetryable(error) || localHubId === "") {
          throw error;
        }
        const peerResult = await forwardToPeerHubs(input, localHubId);
        if (peerResult !== null) {
          return peerResult;
        }
        throw error;
      }
    }

    if (localHubId !== "") {
      const peerResult = await forwardToPeerHubs(input, localHubId);
      if (peerResult !== null) {
        return peerResult;
      }
    }

    throwNoRouteForAgent(deps, input);
  };

  return async (input: DispatchRpcCommandInput): Promise<DispatchRpcCommandResult> => {
    if (!deps.presence.isEnabled) {
      return deps.localDispatch(input);
    }

    if (deps.isAgentRegisteredLocally(input.agentId)) {
      return deps.localDispatch(input);
    }

    const localHubId = env.hubInstanceId.trim();
    return forwardViaPresenceOrPeers(input, localHubId);
  };
};
