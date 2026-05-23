import { Router } from "express";

import { listMyAgents, listUserAgents } from "../controllers/user_agents.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccountSnapshot, requireRole } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import { userIdParamSchema, userListAgentsQuerySchema } from "../validators/user_agents.validator";

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
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
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
userAgentsRouter.get(
  "/me/agents",
  ...requireAuthAndActiveAccountSnapshot,
  validateRequest({ query: userListAgentsQuerySchema }),
  asyncHandler(listMyAgents),
);

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
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
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
  ...requireAuthAndActiveAccountSnapshot,
  requireRole("admin"),
  validateRequest({ params: userIdParamSchema, query: userListAgentsQuerySchema }),
  asyncHandler(listUserAgents),
);
