import type { Request, Response } from "express";
import { container } from "../../../shared/di/container";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { UserIdParam } from "../validators/user_agents.validator";

export const listMyAgents = async (_request: Request, response: Response): Promise<void> => {
  const { sub: userId } = getAuthUser(response);
  const agents = await container.userAgentService.listByUserId(userId);
  response.status(200).json({ agents, count: agents.length });
};

export const listUserAgents = async (_request: Request, response: Response): Promise<void> => {
  const { userId } = getValidated<UserIdParam>(response, "params");
  const agents = await container.userAgentService.listByUserId(userId);
  response.status(200).json({ agents, count: agents.length });
};
