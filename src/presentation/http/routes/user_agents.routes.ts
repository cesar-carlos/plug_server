import { Router } from "express";

import { listMyAgents, listUserAgents } from "../controllers/user_agents.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount, requireRole } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import { userIdParamSchema } from "../validators/user_agents.validator";

export const userAgentsRouter = Router();

/**
 * @openapi
 * /me/agents:
 *   get:
 *     summary: List agents managed by the current user
 *     description: Returns enriched PlugAgente rows for each agent owned through `AgentIdentity`.
 *     tags: [User agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Managed agents for the authenticated user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agents, count]
 *               properties:
 *                 agents:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/UserAgentEnriched'
 *                 count:
 *                   type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
userAgentsRouter.get("/me/agents", ...requireAuthAndActiveAccount, asyncHandler(listMyAgents));

/**
 * @openapi
 * /users/{userId}/agents:
 *   get:
 *     summary: List agents managed by a user (admin)
 *     tags: [User agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Managed agents for the given user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agents, count]
 *               properties:
 *                 agents:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/UserAgentEnriched'
 *                 count:
 *                   type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
userAgentsRouter.get(
  "/users/:userId/agents",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ params: userIdParamSchema }),
  asyncHandler(listUserAgents),
);
