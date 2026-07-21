import {
  createDispatchOrForwardRpcCommand,
  installBridgeCommandSubscriber,
  type DispatchRpcCommandInput as ForwardDispatchInput,
} from "../../../../application/services/agent_hub_bridge_forward.service";
import {
  getAgentHubPresencePort,
  publishBridgeCommand,
  publishBridgeReply,
  startBridgeCommandSubscriber,
  waitForBridgeReply,
} from "../../../../infrastructure/redis/presence/agent_hub_presence_redis";
import { agentRegistry } from "../registries/agent_registry";
import type { StreamEventHandlers } from "../registries/rest_pending_requests";
import type {
  DispatchRpcCommandInput,
  DispatchRpcCommandResult,
} from "./rpc_bridge_dispatch_command";
import { createDispatchRpcCommandToAgent } from "./rpc_bridge_dispatch_command";
import type { RpcBridgeCommandDispatchDeps } from "./rpc_bridge_dispatch_command";

export const createAgentHubBridgeDispatch = (
  bridgeDeps: RpcBridgeCommandDispatchDeps,
): ((input: DispatchRpcCommandInput) => Promise<DispatchRpcCommandResult>) => {
  const localDispatch = createDispatchRpcCommandToAgent(bridgeDeps);
  const forwardDeps = {
    presence: getAgentHubPresencePort(),
    isAgentRegisteredLocally: (agentId: string): boolean => agentRegistry.isRegistered(agentId),
    hasKnownAgentId: (agentId: string): boolean => agentRegistry.hasKnownAgentId(agentId),
    localDispatch: async (fwdInput: ForwardDispatchInput): Promise<DispatchRpcCommandResult> =>
      localDispatch({
        agentId: fwdInput.agentId,
        command: fwdInput.command,
        ...(fwdInput.timeoutMs !== undefined ? { timeoutMs: fwdInput.timeoutMs } : {}),
        ...(fwdInput.payloadFrameCompression !== undefined
          ? { payloadFrameCompression: fwdInput.payloadFrameCompression }
          : {}),
        ...(fwdInput.signal !== undefined ? { signal: fwdInput.signal } : {}),
        ...(fwdInput.streamHandlers !== undefined
          ? { streamHandlers: fwdInput.streamHandlers as StreamEventHandlers }
          : {}),
      }),
    publishCommand: publishBridgeCommand,
    publishReply: publishBridgeReply,
    waitForReply: waitForBridgeReply,
    onBridgeCommand: startBridgeCommandSubscriber,
  };
  installBridgeCommandSubscriber(forwardDeps);
  const forwardOrLocal = createDispatchOrForwardRpcCommand(forwardDeps);

  return async (input: DispatchRpcCommandInput): Promise<DispatchRpcCommandResult> =>
    forwardOrLocal({
      agentId: input.agentId,
      command: input.command,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.payloadFrameCompression !== undefined
        ? { payloadFrameCompression: input.payloadFrameCompression }
        : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.streamHandlers !== undefined ? { streamHandlers: input.streamHandlers } : {}),
    });
};
