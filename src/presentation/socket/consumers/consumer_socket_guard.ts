import type { AgentAccessPrincipal } from "../../../application/services/agent_access.service";
import { container } from "../../../shared/di/container";
import { AppError } from "../../../shared/errors/app_error";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { assertJwtUserAccountActive } from "../auth/ensure_socket_active_account";

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

export const assertConsumerSocketAgentAccess = async (
  user: JwtAccessPayload | undefined,
  agentId: string,
): Promise<AgentAccessPrincipal> => {
  await assertJwtUserAccountActive(user);

  const principal = resolveConsumerAgentAccessPrincipal(user);
  if (!principal) {
    throw new AppError("Authentication required", { code: "UNAUTHORIZED", statusCode: 401 });
  }

  const accessResult = await container.agentAccessService.assertPrincipalAccess(principal, agentId);
  if (!accessResult.ok) {
    throw accessResult.error;
  }

  return principal;
};
