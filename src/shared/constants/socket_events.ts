export const socketEvents = {
  connectionReady: "connection:ready",
  appError: "app:error",
  agentRegister: "agent:register",
  agentCapabilities: "agent:capabilities",
  agentHeartbeat: "agent:heartbeat",
  hubHeartbeatAck: "hub:heartbeat_ack",
} as const;
