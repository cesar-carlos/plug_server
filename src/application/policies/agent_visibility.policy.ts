import type { JwtAccessPayload } from "../../shared/utils/jwt";

export const isJwtAdmin = (user: JwtAccessPayload): boolean => user.role === "admin";

export const resolveVisibleAgentIds = async (
  user: JwtAccessPayload,
  listAgentIdsByUserId: (userId: string) => Promise<readonly string[]>,
): Promise<readonly string[] | undefined> => {
  if (isJwtAdmin(user)) {
    return undefined;
  }
  return listAgentIdsByUserId(user.sub);
};

export const canReadAgentByLink = async (
  user: JwtAccessPayload,
  agentId: string,
  isAgentLinkedToUser: (userId: string, agentId: string) => Promise<boolean>,
): Promise<boolean> => {
  if (isJwtAdmin(user)) {
    return true;
  }
  return isAgentLinkedToUser(user.sub, agentId);
};
