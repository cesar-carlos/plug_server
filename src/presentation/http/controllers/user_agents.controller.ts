import type { Request, Response, NextFunction } from "express";
import { container } from "../../../shared/di/container";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { UserIdParam } from "../validators/user_agents.validator";

export const listMyAgents = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sub: userId } = getAuthUser(response);
    const agents = await container.userAgentService.listByUserId(userId);
    response.status(200).json({ agents, count: agents.length });
  } catch (e) {
    next(e);
  }
};

export const listUserAgents = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId } = getValidated<UserIdParam>(response, "params");
    const agents = await container.userAgentService.listByUserId(userId);
    response.status(200).json({ agents, count: agents.length });
  } catch (e) {
    next(e);
  }
};
