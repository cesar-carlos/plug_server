import { Router } from "express";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount, requireRole } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  createAgentBodySchema,
  updateAgentBodySchema,
  agentIdParamSchema,
  listAgentsQuerySchema,
} from "../validators/agent_catalog.validator";
import {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  deactivateAgent,
} from "../controllers/agent_catalog.controller";

export const agentCatalogRouter = Router();

/**
 * @openapi
 * /agents/catalog:
 *   post:
 *     summary: Create agent catalog record
 *     description: Admin only. `cnpjCpf` is validated (CPF/CNPJ), normalized to digits-only, and must be unique.
 *     tags: [Agent catalog]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentCatalogRequest'
 *     responses:
 *       201:
 *         description: Agent created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agent]
 *               properties:
 *                 agent:
 *                   $ref: '#/components/schemas/AgentCatalogRecord'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
agentCatalogRouter.post(
  "/",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ body: createAgentBodySchema }),
  asyncHandler(createAgent),
);

/**
 * @openapi
 * /agents/catalog:
 *   get:
 *     summary: List agents in the catalog
 *     description: >
 *       Admins see the full catalog with optional filters. Non-admin users only see agents linked to their account;
 *       pagination totals apply within that visible subset. Same query parameters apply to both roles.
 *     tags: [Agent catalog]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *           maxLength: 120
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
 *         description: List of catalog agents
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedAgentCatalogResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
agentCatalogRouter.get(
  "/",
  ...requireAuthAndActiveAccount,
  validateRequest({ query: listAgentsQuerySchema }),
  asyncHandler(listAgents),
);

/**
 * @openapi
 * /agents/catalog/{agentId}:
 *   get:
 *     summary: Get one catalog agent by id
 *     description: >
 *       Admins can read any catalog record. Non-admins receive 403 if the agent is not linked to their account
 *       (including inactive agents they are linked to).
 *     tags: [Agent catalog]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Agent found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agent]
 *               properties:
 *                 agent:
 *                   $ref: '#/components/schemas/AgentCatalogRecord'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
agentCatalogRouter.get(
  "/:agentId",
  ...requireAuthAndActiveAccount,
  validateRequest({ params: agentIdParamSchema }),
  asyncHandler(getAgent),
);

/**
 * @openapi
 * /agents/catalog/{agentId}:
 *   patch:
 *     summary: Update catalog agent fields
 *     description: Admin only. At least one of name, cnpjCpf, observation (nullable to clear).
 *     tags: [Agent catalog]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAgentCatalogRequest'
 *     responses:
 *       200:
 *         description: Updated agent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agent]
 *               properties:
 *                 agent:
 *                   $ref: '#/components/schemas/AgentCatalogRecord'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
agentCatalogRouter.patch(
  "/:agentId",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ params: agentIdParamSchema, body: updateAgentBodySchema }),
  asyncHandler(updateAgent),
);

/**
 * @openapi
 * /agents/catalog/{agentId}:
 *   delete:
 *     summary: Deactivate agent (logical delete)
 *     description: Admin only. Sets status to `inactive`; record and bindings remain.
 *     tags: [Agent catalog]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Agent deactivated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agent]
 *               properties:
 *                 agent:
 *                   $ref: '#/components/schemas/AgentCatalogRecord'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
agentCatalogRouter.delete(
  "/:agentId",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  validateRequest({ params: agentIdParamSchema }),
  asyncHandler(deactivateAgent),
);
