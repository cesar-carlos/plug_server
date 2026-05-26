/**
 * Helpers for emitting `agent:register_error` to a registering agent socket.
 *
 * Per `socket_communication_standard.md` (Mapa rapido de eventos), this event
 * is emitted as a **plain JSON object** (NOT a `PayloadFrame`) with the shape
 * `{ code, reason, message, details? }`. The agent reads `reason` to decide:
 *   - `transient_failure` / `rate_limited` → reschedule a new `agent:register`
 *   - any other reason                     → force a reconnect cycle
 *
 * Keeping the payload outside `PayloadFrame` is intentional: the agent must be
 * able to parse it without a working transport-frame negotiation (since the
 * failure may itself indicate a malformed frame on the way in).
 */

import type { Socket } from "socket.io";

import { socketEvents } from "../../../../shared/constants/socket_events";
import { logger } from "../../../../shared/utils/logger";

/**
 * Stable `reason` codes accepted by plug_agente when receiving
 * `agent:register_error`. Agents map these to recovery strategies:
 *   - `transient_failure`, `rate_limited` → schedule another `agent:register`
 *   - all others → drop the connection and let the reconnect loop start over
 */
export type AgentRegisterErrorReason =
  | "invalid_request"
  | "invalid_payload"
  | "authentication_failed"
  | "unauthorized"
  | "rate_limited"
  | "transient_failure"
  | "internal_error"
  | "session_active";

/** Stable English copy for `reason: session_active` (agents may i18n via `reason`). */
export const AGENT_REGISTER_SESSION_ACTIVE_MESSAGE =
  "Another session for this agent is already connected to this hub. Close the agent on the other device or wait for it to disconnect, then try again.";

export const AGENT_REGISTER_RATE_LIMIT_MESSAGE =
  "Too many agent registration attempts in a short period. Wait before retrying agent:register.";

/** Hub → superseded socket JSON (`agent:session.superseded`). */
export const AGENT_SESSION_SUPERSEDED_MESSAGE =
  "This session was superseded by a newer connection for the same agent on this hub.";

export type AgentSessionSupersededReason = "session_superseded";

/** Plain-JSON wire shape for `agent:session.superseded` (NOT a `PayloadFrame`). */
export interface AgentSessionSupersededPayload {
  readonly reason: AgentSessionSupersededReason;
  readonly message: string;
  readonly policy: string;
}

const codeForReason: Record<AgentRegisterErrorReason, number> = {
  invalid_request: -32600,
  invalid_payload: -32009,
  authentication_failed: -32001,
  unauthorized: -32002,
  rate_limited: -32013,
  transient_failure: -32603,
  internal_error: -32603,
  session_active: -32014,
};

export interface AgentRegisterErrorPayload {
  readonly code: number;
  readonly reason: AgentRegisterErrorReason;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

const buildAgentRegisterErrorPayload = (
  reason: AgentRegisterErrorReason,
  message: string,
  details?: Record<string, unknown>,
): AgentRegisterErrorPayload => ({
  code: codeForReason[reason],
  reason,
  message,
  ...(details !== undefined ? { details } : {}),
});

/**
 * Emit `agent:register_error` as plain JSON (no `PayloadFrame`) and log the
 * decision so operators can see why a register attempt was rejected.
 */
export const emitAgentRegisterError = (
  socket: Socket,
  reason: AgentRegisterErrorReason,
  message: string,
  context?: Record<string, unknown>,
  details?: Record<string, unknown>,
): void => {
  const payload = buildAgentRegisterErrorPayload(reason, message, details);
  socket.emit(socketEvents.agentRegisterError, payload);
  logger.warn("agent_register_error_emitted", {
    socketId: socket.id,
    code: payload.code,
    reason: payload.reason,
    message: payload.message,
    ...(payload.details !== undefined ? { details: payload.details } : {}),
    ...context,
  });
};
