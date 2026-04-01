import { Router } from "express";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount, requireRole } from "../middlewares/auth.middleware";
import { meAgentsPostRateLimit } from "../middlewares/rate_limit.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import { agentIdsBodySchema, userIdParamSchema } from "../validators/user_agents.validator";
import {
  listMyAgents,
  listUserAgents,
  addMyAgents,
  removeMyAgents,
  addUserAgents,
  removeUserAgents,
  replaceUserAgents,
} from "../controllers/user_agents.controller";

export const userAgentsRouter = Router();

/**
 * @openapi
 * /me/agents:
 *   get:
 *     summary: List agents linked to the current user
 *     description: Returns enriched rows (name, cnpjCpf, observation, status) from the catalog for each bound agentId.
 *     tags: [User agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Linked agents for the authenticated user
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
 * /me/agents:
 *   post:
 *     summary: Add agent ids to your own list (self-service)
 *     description: |
 *       Each agent must exist in the catalog with status **active**, and be **currently connected**
 *       on the `/agents` namespace under **your** account (same JWT `sub` as the live socket).
 *       Self-service bind is rate-limited per user (`REST_ME_AGENTS_POST_RATE_LIMIT_*`).
 *       Admin routes under `/users/{userId}/agents` can still manage any user's list without the online check.
 *     tags: [User agents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentIdsBody'
 *     responses:
 *       200:
 *         description: Agents added (or already linked to you)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Agents added successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Forbidden — e.g. agent inactive in catalog (`AGENT_INACTIVE`)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: One or more agentIds not in catalog
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Agent already bound to another user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Agent not connected for your account right now (`details.reason` offline or different_account)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Too many self-service bind requests for this user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
userAgentsRouter.post(
  "/me/agents",
  ...requireAuthAndActiveAccount,
  meAgentsPostRateLimit,
  validateRequest({ body: agentIdsBodySchema }),
  asyncHandler(addMyAgents),
);

/**
 * @openapi
 * /me/agents:
 *   delete:
 *     summary: Remove agent ids from your own list (self-service)
 *     description: Idempotent; missing links are ignored.
 *     tags: [User agents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentIdsBody'
 *     responses:
 *       200:
 *         description: Agents removed (or already absent)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Agents removed successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
userAgentsRouter.delete(
  "/me/agents",
  ...requireAuthAndActiveAccount,
  validateRequest({ body: agentIdsBodySchema }),
  asyncHandler(removeMyAgents),
);

/**
 * @openapi
 * /users/{userId}/agents:
 *   get:
 *     summary: List agents linked to a user (admin)
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
 *         description: Linked agents for the given user
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

/**
 * @openapi
 * /users/{userId}/agents:
 *   post:
 *     summary: Add agent ids to a user's list (admin)
 *     description: Fails if any agentId is missing from the catalog or already bound to another user.
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentIdsBody'
 *     responses:
 *       200:
 *         description: Agents added
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Agents added successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: One or more agentIds not in catalog
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Agent already bound to another user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
userAgentsRouter.post(
  "/users/:userId/agents",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ params: userIdParamSchema, body: agentIdsBodySchema }),
  asyncHandler(addUserAgents),
);

/**
 * @openapi
 * /users/{userId}/agents:
 *   delete:
 *     summary: Remove agent ids from a user's list (admin)
 *     description: Idempotent; missing links are ignored.
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentIdsBody'
 *     responses:
 *       200:
 *         description: Agents removed (or already absent)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Agents removed successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
userAgentsRouter.delete(
  "/users/:userId/agents",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ params: userIdParamSchema, body: agentIdsBodySchema }),
  asyncHandler(removeUserAgents),
);

/**
 * @openapi
 * /users/{userId}/agents:
 *   put:
 *     summary: Replace the user's entire agent list (admin)
 *     description: Transactional replace. Same validation as POST for conflicts and catalog existence.
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentIdsBody'
 *     responses:
 *       200:
 *         description: List replaced
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Agent list replaced successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: One or more agentIds not in catalog
 *       409:
 *         description: Agent already bound to another user
 */
userAgentsRouter.put(
  "/users/:userId/agents",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ params: userIdParamSchema, body: agentIdsBodySchema }),
  asyncHandler(replaceUserAgents),
);
