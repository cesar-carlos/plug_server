import type { Request, Response, NextFunction } from "express";
import { container } from "../../../shared/di/container";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { AgentIdsBody, UserIdParam } from "../validators/user_agents.validator";

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

export const addUserAgents = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId } = getValidated<UserIdParam>(response, "params");
    const { agentIds } = getValidated<AgentIdsBody>(response, "body");
    const result = await container.userAgentService.addAgentIds(userId, agentIds);
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({ message: "Agents added successfully" });
  } catch (e) {
    next(e);
  }
};

export const removeUserAgents = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId } = getValidated<UserIdParam>(response, "params");
    const { agentIds } = getValidated<AgentIdsBody>(response, "body");
    const result = await container.userAgentService.removeAgentIds(userId, agentIds);
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({ message: "Agents removed successfully" });
  } catch (e) {
    next(e);
  }
};

export const replaceUserAgents = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId } = getValidated<UserIdParam>(response, "params");
    const { agentIds } = getValidated<AgentIdsBody>(response, "body");
    const result = await container.userAgentService.replaceAgentIds(userId, agentIds);
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({ message: "Agent list replaced successfully" });
  } catch (e) {
    next(e);
  }
};
