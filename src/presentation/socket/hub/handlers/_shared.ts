import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace, Socket } from "socket.io";

import { buildLegacySocketAppErrorPayload } from "../../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../../shared/constants/socket_events";
import type { JwtAccessPayload } from "../../../../shared/utils/jwt";
import type { AgentRegisterProfileSnapshot } from "../../../../application/services/agent_profile_sync.service";
import type { AgentRegisterPayload } from "../../../../shared/validators/agent_register";

/**
 * Shared types and tiny helpers used by every handler file under
 * `presentation/socket/hub/handlers/`. Centralizes the socket-data shape and
 * the protocol-error emission so individual handlers stay focused on the
 * business of their event.
 */

export type AgentCapabilities = AgentRegisterPayload["capabilities"];

export type AgentSocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: AgentCapabilities;
  agentRegisterProfileSnapshot?: AgentRegisterProfileSnapshot;
};

export type AgentHubSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  AgentSocketData
>;

export type AgentHubNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  AgentSocketData
>;

export const emitAppError = (socket: AgentHubSocket, message: string): void => {
  socket.emit(
    socketEvents.appError,
    buildLegacySocketAppErrorPayload("SOCKET_PROTOCOL_ERROR", message),
  );
};

export const getUserId = (socket: AgentHubSocket): string | null =>
  typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const withOptionalRequestId = (
  requestId: string | null | undefined,
): { readonly requestId?: string } => (requestId ? { requestId } : {});
