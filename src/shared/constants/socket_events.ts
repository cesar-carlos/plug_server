export const socketEvents = {
  connectionReady: "connection:ready",
  appError: "app:error",
  agentRegister: "agent:register",
  agentCapabilities: "agent:capabilities",
  agentHeartbeat: "agent:heartbeat",
  hubHeartbeatAck: "hub:heartbeat_ack",
  rpcRequest: "rpc:request",
  rpcResponse: "rpc:response",
  rpcRequestAck: "rpc:request_ack",
  rpcBatchAck: "rpc:batch_ack",
  agentsCommand: "agents:command",
  agentsCommandResponse: "agents:command_response",
} as const;

export const SOCKET_NAMESPACES = {
  agents: "/agents",
  consumers: "/consumers",
} as const;
