import {
  createDispatchOrForwardRpcCommand,
  installBridgeCommandSubscriber,
} from "../../../../application/services/agent_hub_bridge_forward.service";
import {
  getAgentHubPresencePort,
  publishBridgeCommand,
  publishBridgeReply,
  startBridgeCommandSubscriber,
  waitForBridgeReply,
} from "../../../../infrastructure/redis/presence/agent_hub_presence_redis";
import { agentRegistry } from "../registries/agent_registry";
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
    isAgentRegisteredLocally: (agentId: string): boolean =>
      agentRegistry.findByAgentId(agentId) !== null,
    hasKnownAgentId: (agentId: string): boolean => agentRegistry.hasKnownAgentId(agentId),
    localDispatch,
    publishCommand: publishBridgeCommand,
    publishReply: publishBridgeReply,
    waitForReply: waitForBridgeReply,
    onBridgeCommand: startBridgeCommandSubscriber,
  };
  installBridgeCommandSubscriber(forwardDeps);
  return createDispatchOrForwardRpcCommand(forwardDeps);
};
