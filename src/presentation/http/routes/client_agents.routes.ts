import { Router } from "express";

import {
  approveClientAccess,
  clientAccessReviewPage,
  clientAccessStatus,
  getMyClientAgent,
  listMyClientAgentAccessRequests,
  listMyClientAgents,
  rejectClientAccess,
  removeMyClientAgentByParam,
  removeMyClientAgents,
  requestMyClientAgents,
} from "../controllers/client_agents.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { clientMeAgentsPostRateLimit } from "../middlewares/rate_limit.middleware";
import { requireClientAuthAndActiveAccount } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  clientAccessApproveBodySchema,
  clientAccessRejectBodySchema,
  clientAgentIdParamSchema,
  clientAccessReviewTokenQuerySchema,
  clientAgentIdsBodySchema,
  clientListAgentAccessRequestsQuerySchema,
  clientListAgentsQuerySchema,
} from "../validators/client_agents.validator";

export const clientAgentsRouter = Router();
export const clientAccessReviewRouter = Router();

/**
 * @openapi
 * /client/me/agents:
 *   get:
 *     summary: List approved agents for the authenticated client
 *     tags: [Client Agent Access]
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
 *       - in: query
 *         name: refresh
 *         description: When `true`, refreshes online agents in the current page from the live socket profile before responding.
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Approved agents with profile data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agents, agentIds, count, total, page, pageSize]
 *               properties:
 *                 agents:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ClientAccessibleAgent'
 *                 agentIds:
 *                   type: array
 *                   items: { type: string, format: uuid }
 *                 count:
 *                   type: integer
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 pageSize:
 *                   type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
clientAgentsRouter.get(
  "/client/me/agents",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ query: clientListAgentsQuerySchema }),
  asyncHandler(listMyClientAgents),
);
/**
 * @openapi
 * /client/me/agents/{agentId}:
 *   get:
 *     summary: Get one approved agent for the authenticated client
 *     tags: [Client Agent Access]
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
 *         description: Approved agent profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agent]
 *               properties:
 *                 agent:
 *                   $ref: '#/components/schemas/ClientAccessibleAgent'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
clientAgentsRouter.get(
  "/client/me/agents/:agentId",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ params: clientAgentIdParamSchema }),
  asyncHandler(getMyClientAgent),
);
/**
 * @openapi
 * /client/me/agents/{agentId}:
 *   delete:
 *     summary: Remove approved client access for one agent (path variant)
 *     description: Same effect as `DELETE /client/me/agents` with a single id in `agentIds`. Marks prior `approved` request rows as `revoked` when applicable.
 *     tags: [Client Agent Access]
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
 *         description: Access removed (idempotent)
 */
clientAgentsRouter.delete(
  "/client/me/agents/:agentId",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ params: clientAgentIdParamSchema }),
  asyncHandler(removeMyClientAgentByParam),
);
/**
 * @openapi
 * /client/me/agents:
 *   post:
 *     summary: Request access to one or more agents
 *     description: >
 *       Validates each `agentId`. If approved access already exists (`ClientAgentAccess`), returns that id in
 *       `alreadyApproved` and does not email the owner. Otherwise creates or refreshes a `pending`
 *       `ClientAgentAccessRequest` (including after the client removed access with `DELETE /client/me/agents`
 *       while the prior request row was still `approved`), issues a new approval token, and emails the agent owner.
 *     tags: [Client Agent Access]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agentIds]
 *             properties:
 *               agentIds:
 *                 type: array
 *                 minItems: 1
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Access request processing result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [requested, alreadyApproved, newRequests, reopened, debounced]
 *               properties:
 *                 requested:
 *                   type: array
 *                   description: Agent IDs for which a pending request was saved and the owner was emailed in this call
 *                   items: { type: string, format: uuid }
 *                 alreadyApproved:
 *                   type: array
 *                   description: Agent IDs that already had `ClientAgentAccess` for this client
 *                   items: { type: string, format: uuid }
 *                 newRequests:
 *                   type: array
 *                   description: Subset of `requested` with no prior `ClientAgentAccessRequest` row
 *                   items: { type: string, format: uuid }
 *                 reopened:
 *                   type: array
 *                   description: Subset of `requested` that reopened an existing request row
 *                   items: { type: string, format: uuid }
 *                 debounced:
 *                   type: array
 *                   description: Agent IDs skipped because a pending request was refreshed within the debounce window (no new email)
 *                   items: { type: string, format: uuid }
 *       404:
 *         description: One or more agents not found
 */
clientAgentsRouter.post(
  "/client/me/agents",
  ...requireClientAuthAndActiveAccount,
  clientMeAgentsPostRateLimit,
  validateRequest({ body: clientAgentIdsBodySchema }),
  asyncHandler(requestMyClientAgents),
);
/**
 * @openapi
 * /client/me/agents:
 *   delete:
 *     summary: Remove approved client access to one or more agents (JSON body)
 *     description: Removes `ClientAgentAccess` rows. If the paired request was `approved`, it is marked `revoked` with reason `client_revoked_access`.
 *     tags: [Client Agent Access]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agentIds]
 *             properties:
 *               agentIds:
 *                 type: array
 *                 minItems: 1
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Accesses removed
 */
clientAgentsRouter.delete(
  "/client/me/agents",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ body: clientAgentIdsBodySchema }),
  asyncHandler(removeMyClientAgents),
);
/**
 * @openapi
 * /client/me/agent-access-requests:
 *   get:
 *     summary: List client access requests and their statuses
 *     tags: [Client Agent Access]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, rejected, expired, revoked]
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
 *         description: Request list for authenticated client
 */
clientAgentsRouter.get(
  "/client/me/agent-access-requests",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ query: clientListAgentAccessRequestsQuerySchema }),
  asyncHandler(listMyClientAgentAccessRequests),
);

/**
 * @openapi
 * /client-access/review:
 *   get:
 *     summary: Render review page for approval token
 *     tags: [Client Agent Access]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: HTML review page
 */
clientAccessReviewRouter.get(
  "/review",
  validateRequest({ query: clientAccessReviewTokenQuerySchema }),
  asyncHandler(clientAccessReviewPage),
);
/**
 * @openapi
 * /client-access/status:
 *   get:
 *     summary: Read access request status by token
 *     tags: [Client Agent Access]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Status payload for current access request
 */
clientAccessReviewRouter.get(
  "/status",
  validateRequest({ query: clientAccessReviewTokenQuerySchema }),
  asyncHandler(clientAccessStatus),
);
/**
 * @openapi
 * /client-access/approve:
 *   post:
 *     summary: Approve client access request by token
 *     tags: [Client Agent Access]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: HTML confirmation page (approved)
 */
clientAccessReviewRouter.post(
  "/approve",
  validateRequest({ body: clientAccessApproveBodySchema }),
  asyncHandler(approveClientAccess),
);
/**
 * @openapi
 * /client-access/reject:
 *   post:
 *     summary: Reject client access request by token
 *     tags: [Client Agent Access]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       200:
 *         description: HTML confirmation page (rejected)
 */
clientAccessReviewRouter.post(
  "/reject",
  validateRequest({ body: clientAccessRejectBodySchema }),
  asyncHandler(rejectClientAccess),
);
