import type { Request, Response } from "express";
import { container } from "../../../shared/di/container";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { UserIdParam, UserListAgentsQuery } from "../validators/user_agents.validator";

const hasPaginationQuery = (query: UserListAgentsQuery): boolean =>
  query.page !== undefined || query.pageSize !== undefined;

/**
 * Shared body for the "list agents managed by a user" endpoints. `/me/agents`
 * derives `userId` from the JWT; `/users/:userId/agents` (admin) takes it from
 * the path — the listing/pagination behavior is otherwise identical.
 */
const respondManagedAgents = async (
  response: Response,
  userId: string,
  query: UserListAgentsQuery,
): Promise<void> => {
  if (hasPaginationQuery(query)) {
    const pageResult = await container.userAgentService.listByUserIdPage(userId, {
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
    });
    response.status(200).json({
      agents: pageResult.agents,
      count: pageResult.agents.length,
      total: pageResult.total,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
    });
    return;
  }

  const agents = await container.userAgentService.listByUserId(userId);
  response.status(200).json({ agents, count: agents.length });
};

export const listMyAgents = async (_request: Request, response: Response): Promise<void> => {
  const { sub: userId } = getAuthUser(response);
  const query = getValidated<UserListAgentsQuery>(response, "query");
  await respondManagedAgents(response, userId, query);
};

export const listUserAgents = async (_request: Request, response: Response): Promise<void> => {
  const { userId } = getValidated<UserIdParam>(response, "params");
  const query = getValidated<UserListAgentsQuery>(response, "query");
  await respondManagedAgents(response, userId, query);
};
