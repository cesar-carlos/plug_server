export const socketEvents = {
  connectionReady: "connection:ready",
  appError: "app:error",
  agentRegister: "agent:register",
  /**
   * Hub → agent rejection of `agent:register`. Emitted as **plain JSON**
   * (NOT a `PayloadFrame`) per `socket_communication_standard.md` "Mapa rapido
   * de eventos": `{ code, reason, message }`. The agent uses `reason` to decide
   * between rescheduling registration (`transient_failure`, `rate_limited`) or
   * forcing a reconnect (anything else, e.g. `authentication_failed`,
   * `invalid_request`).
   */
  agentRegisterError: "agent:register_error",
  /** Hub → agent: previous session replaced under `takeover_disconnect_previous` policy (plain JSON). */
  agentSessionSuperseded: "agent:session.superseded",
  agentCapabilities: "agent:capabilities",
  agentReady: "agent:ready",
  agentHeartbeat: "agent:heartbeat",
  agentProfileUpdate: "agent:profile.update",
  agentProfileUpdated: "agent:profile.updated",
  hubHeartbeatAck: "hub:heartbeat_ack",
  rpcRequest: "rpc:request",
  rpcResponse: "rpc:response",
  rpcRequestAck: "rpc:request_ack",
  rpcBatchAck: "rpc:batch_ack",
  rpcChunk: "rpc:chunk",
  rpcComplete: "rpc:complete",
  rpcStreamPull: "rpc:stream.pull",
  agentsCommand: "agents:command",
  agentsCommandResponse: "agents:command_response",
  agentsCommandStreamChunk: "agents:command_stream_chunk",
  agentsCommandStreamComplete: "agents:command_stream_complete",
  agentsStreamPull: "agents:stream_pull",
  agentsStreamPullResponse: "agents:stream_pull_response",
  relayConversationStart: "relay:conversation.start",
  relayConversationStarted: "relay:conversation.started",
  relayConversationEnd: "relay:conversation.end",
  relayConversationEnded: "relay:conversation.ended",
  relayRpcRequest: "relay:rpc.request",
  /**
   * Batch variant of `relay:rpc.request` carrying 1..N JSON-RPC items in a
   * single envelope. See `docs/adrs/0008-relay-batch-protocol.md`. Gated by
   * `SOCKET_RELAY_BATCH_ENABLED` (default `false`). Per-item responses still
   * arrive on `relay:rpc.response`; the batch ack is delivered as a single
   * `relay:rpc.batch_accepted` event.
   */
  relayRpcRequestBatch: "relay:rpc.request.batch",
  relayRpcAccepted: "relay:rpc.accepted",
  /**
   * Single ack covering an entire `relay:rpc.request.batch`. Carries the
   * per-item `clientRequestId → requestId` correlation plus dedup state for
   * each item. Emitted exactly once per inbound batch envelope.
   */
  relayRpcBatchAccepted: "relay:rpc.batch_accepted",
  relayRpcResponse: "relay:rpc.response",
  relayRpcChunk: "relay:rpc.chunk",
  relayRpcComplete: "relay:rpc.complete",
  relayRpcRequestAck: "relay:rpc.request_ack",
  relayRpcBatchAck: "relay:rpc.batch_ack",
  relayRpcStreamPull: "relay:rpc.stream.pull",
  relayRpcStreamPullResponse: "relay:rpc.stream.pull_response",
  socketEventSubscribe: "socket:event.subscribe",
  socketEventSubscribed: "socket:event.subscribed",
  socketEventUnsubscribe: "socket:event.unsubscribe",
  socketEventUnsubscribed: "socket:event.unsubscribed",
  /** Consumer → hub: publish a `client:custom.*` event (same semantics as REST). */
  socketEventPublish: "socket:event.publish",
  /** Hub → consumer: acknowledgement for `socket:event.publish`. */
  socketEventPublished: "socket:event.published",
  /** Server → consumer: agent catalog profile changed (approved clients only). */
  clientAgentProfileUpdated: "client:agent.profile.updated",
} as const;

export const SOCKET_NAMESPACES = {
  agents: "/agents",
  consumers: "/consumers",
} as const;
