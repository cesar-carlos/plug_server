import { socketEvents } from "../../../../shared/constants/socket_events";
import {
  decodePayloadFrame,
  decodePayloadFrameAsync,
  encodePayloadFrameHotPath,
  type DecodedPayloadFrame,
} from "../../../../shared/utils/payload_frame";
import {
  runAgentHubPresenceSyncSafely,
  syncAgentHubPresenceOnTouch,
} from "../../../../application/services/agent_hub_presence_sync";
import { agentRegistry } from "../registries/agent_registry";
import { allowAgentHeartbeatSocketEvent } from "../rate_limits/agent_heartbeat_socket_rate_limiter";
import { emitAppError, isRecord, withOptionalRequestId, type AgentHubSocket } from "./_shared";

interface HeartbeatState {
  tail: Promise<void>;
  cancelled: boolean;
}
const states = new WeakMap<AgentHubSocket, HeartbeatState>();

export const cleanupAgentHeartbeatState = (socket: AgentHubSocket): void => {
  const state = states.get(socket);
  if (state) state.cancelled = true;
  states.delete(socket);
};

const commitHeartbeat = (
  socket: AgentHubSocket,
  decoded: DecodedPayloadFrame,
  expectedAgentId: string | undefined,
): void => {
  if (socket.connected === false || socket.data.agentId !== expectedAgentId) return;
  const payload = isRecord(decoded.data) ? decoded.data : {};
  const agentId = socket.data.agentId;
  if (!agentId) {
    emitAppError(socket, "agent:heartbeat received before agent registration");
    return;
  }
  if (typeof payload.agent_id === "string" && payload.agent_id !== agentId) {
    emitAppError(socket, "agent:heartbeat agent_id does not match registered socket agent");
    return;
  }
  if (agentRegistry.getSocketIdByAgentId(agentId) !== socket.id) {
    emitAppError(socket, "agent:heartbeat received from non-canonical agent socket");
    return;
  }
  const readiness = agentRegistry.getProtocolReadiness(agentId);
  const waitingExplicitAck =
    !readiness.ready && agentRegistry.getProtocolReadyMode(agentId) === "explicit_ack";
  agentRegistry.touchLiveness(agentId, {
    markProtocolReady: !waitingExplicitAck,
    socketId: socket.id,
  });
  runAgentHubPresenceSyncSafely({
    operation: "touch",
    agentId,
    socketId: socket.id,
    sync: () => syncAgentHubPresenceOnTouch(agentId),
  });
  const traceId =
    typeof payload.trace_id === "string" && payload.trace_id.trim() !== ""
      ? payload.trace_id
      : undefined;
  socket.emit(
    socketEvents.hubHeartbeatAck,
    encodePayloadFrameHotPath(
      {
        agent_id: agentId,
        timestamp: new Date().toISOString(),
        status: "ok",
        ...(traceId !== undefined ? { trace_id: traceId } : {}),
      },
      withOptionalRequestId(decoded.frame.requestId),
    ),
  );
};

/** Synchronous tiny frames stay fast; gzip and later heartbeats commit in arrival order. */
export const handleAgentHeartbeat = (
  socket: AgentHubSocket,
  rawPayload: unknown,
): void | Promise<void> => {
  if (!allowAgentHeartbeatSocketEvent(socket.id)) {
    emitAppError(socket, "agent:heartbeat rate limit exceeded");
    socket.disconnect(true);
    return;
  }
  const expectedAgentId = socket.data.agentId;
  const existing = states.get(socket);
  const gzip = isRecord(rawPayload) && rawPayload.cmp === "gzip";
  if (!existing && !gzip) {
    const decoded = decodePayloadFrame(rawPayload);
    if (!decoded.ok) emitAppError(socket, decoded.error.message);
    else commitHeartbeat(socket, decoded.value, expectedAgentId);
    return;
  }
  const state = existing ?? { tail: Promise.resolve(), cancelled: false };
  states.set(socket, state);
  const task = state.tail.then(async () => {
    if (state.cancelled || socket.connected === false) return;
    const decoded = await decodePayloadFrameAsync(rawPayload);
    if (
      state.cancelled ||
      (socket as AgentHubSocket).connected === false ||
      socket.data.agentId !== expectedAgentId
    )
      return;
    if (!decoded.ok) emitAppError(socket, decoded.error.message);
    else commitHeartbeat(socket, decoded.value, expectedAgentId);
  });
  // A failing decode must not prevent subsequent heartbeats from acquiring their turn.
  const tail = task.then(
    () => undefined,
    () => undefined,
  );
  state.tail = tail;
  void tail.then(() => {
    if (state.tail === tail && states.get(socket) === state) states.delete(socket);
  });
  return task;
};
