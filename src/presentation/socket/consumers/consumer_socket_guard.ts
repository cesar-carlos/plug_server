import type { Socket } from "socket.io";

import type { AgentAccessPrincipal } from "../../../application/services/agent_access.service";
import { container } from "../../../shared/di/container";
import { AppError } from "../../../shared/errors/app_error";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import {
  assertJwtUserAccountActive,
  type SocketAccountSnapshot,
} from "../auth/ensure_socket_active_account";
import { joinConsumerClientAgentRoom } from "../hub/consumer_identity_rooms";

type GuardSocket = Socket & {
  data: { user?: JwtAccessPayload; authSnapshot?: SocketAccountSnapshot };
};

export const resolveSocketActorRole = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.role === "string" && user.role.trim() !== "" ? user.role : null;

export const resolveConsumerAgentAccessPrincipal = (
  user: JwtAccessPayload | undefined,
): AgentAccessPrincipal | null => {
  if (typeof user?.sub !== "string" || user.sub.trim() === "") {
    return null;
  }

  return user.principal_type === "client"
    ? { type: "client", id: user.sub }
    : { type: "user", id: user.sub, ...(user.role !== undefined ? { role: user.role } : {}) };
};

/**
 * Per-event guard for consumer namespace operations. Validates that the JWT is
 * still tied to an active account (lightweight DB snapshot) AND that the principal
 * has access to the requested agent.
 */
export const assertConsumerSocketAgentAccess = async (
  user: JwtAccessPayload | undefined,
  agentId: string,
  socket?: GuardSocket,
): Promise<AgentAccessPrincipal> => {
  await assertJwtUserAccountActive(user, socket);

  const principal = resolveConsumerAgentAccessPrincipal(user);
  if (!principal) {
    throw new AppError("Authentication required", { code: "UNAUTHORIZED", statusCode: 401 });
  }

  const accessResult = await container.agentAccessService.assertPrincipalAccess(principal, agentId);
  if (!accessResult.ok) {
    throw accessResult.error;
  }

  if (principal.type === "client" && socket) {
    await joinConsumerClientAgentRoom(socket, { clientId: principal.id, agentId });
  }

  return principal;
};
