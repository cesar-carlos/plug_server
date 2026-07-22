import { Router } from "express";

import {
  approveMyClientAccessRequest,
  approveMyClientRegistration,
  getMyClient,
  listMyAgentClients,
  listMyClientAccessRequests,
  listMyClients,
  rejectMyClientAccessRequest,
  rejectMyClientRegistration,
  revokeMyAgentClientAccess,
  setMyClientStatus,
} from "../controllers/user_clients.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount, requireRole } from "../middlewares/auth.middleware";
import { meClientDecisionRateLimit } from "../middlewares/rate_limit.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  userAgentClientParamSchema,
  userAgentIdParamSchema,
  userClientAccessRequestIdParamSchema,
  userClientIdParamSchema,
  userListAgentClientsQuerySchema,
  userListClientAccessRequestsQuerySchema,
  userListClientsQuerySchema,
  userRejectClientAccessRequestBodySchema,
  userRejectClientRegistrationBodySchema,
  userSetClientStatusBodySchema,
} from "../validators/user_clients.validator";

export const userClientsRouter = Router();

/**
 * @openapi
 * /me/clients:
 *   get:
 *     summary: List clients managed by authenticated user
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, active, rejected, blocked]
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
 *         description: Paginated managed clients
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [clients, count, total, page, pageSize]
 *               properties:
 *                 clients:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ClientAuthUser'
 *                 count: { type: integer }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
userClientsRouter.get(
  "/me/clients",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ query: userListClientsQuerySchema }),
  asyncHandler(listMyClients),
);

/**
 * @openapi
 * /me/clients/{clientId}:
 *   get:
 *     summary: Get one managed client
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Managed client
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [client]
 *               properties:
 *                 client:
 *                   $ref: '#/components/schemas/ClientAuthUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
userClientsRouter.get(
  "/me/clients/:clientId",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ params: userClientIdParamSchema }),
  asyncHandler(getMyClient),
);

/**
 * @openapi
 * /me/clients/{clientId}/status:
 *   patch:
 *     summary: Update status for an already reviewed managed client (active/blocked)
 *     description: >
 *       Cannot activate or reject `pending`/`rejected` registrations — use the registration
 *       approve/reject flow instead. Blocking revokes refresh tokens and disconnects `/consumers` sockets.
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, blocked]
 *     responses:
 *       200:
 *         description: Updated managed client
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [client]
 *               properties:
 *                 client:
 *                   $ref: '#/components/schemas/ClientAuthUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: Pending/rejected registrations must use the registration approval flow
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
userClientsRouter.patch(
  "/me/clients/:clientId/status",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ params: userClientIdParamSchema, body: userSetClientStatusBodySchema }),
  asyncHandler(setMyClientStatus),
);

/**
 * @openapi
 * /me/clients/{clientId}/registration/approve:
 *   post:
 *     summary: Approve a pending client registration as authenticated owner
 *     description: Works even when the public email approval link has expired. Invalidates pending public registration tokens.
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Client registration approved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [approved, clientEmail]
 *               properties:
 *                 approved: { type: boolean }
 *                 clientEmail: { type: string, format: email }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       503:
 *         $ref: '#/components/responses/ServiceUnavailable'
 */
userClientsRouter.post(
  "/me/clients/:clientId/registration/approve",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  meClientDecisionRateLimit,
  validateRequest({ params: userClientIdParamSchema }),
  asyncHandler(approveMyClientRegistration),
);

/**
 * @openapi
 * /me/clients/{clientId}/registration/reject:
 *   post:
 *     summary: Reject a pending client registration as authenticated owner
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Client registration rejected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [rejected, clientEmail]
 *               properties:
 *                 rejected: { type: boolean }
 *                 clientEmail: { type: string, format: email }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       503:
 *         $ref: '#/components/responses/ServiceUnavailable'
 */
userClientsRouter.post(
  "/me/clients/:clientId/registration/reject",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  meClientDecisionRateLimit,
  validateRequest({
    params: userClientIdParamSchema,
    body: userRejectClientRegistrationBodySchema,
  }),
  asyncHandler(rejectMyClientRegistration),
);

/**
 * @openapi
 * /me/client-access-requests:
 *   get:
 *     summary: List client access requests for agents owned by authenticated user
 *     tags: [User clients]
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
 *         name: agentId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: clientId
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
 *         description: Paginated access requests (includes clientEmail/clientName when available)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [requests, count, total, page, pageSize]
 *               properties:
 *                 requests:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/OwnerClientAgentAccessRequestRecord'
 *                 count: { type: integer }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
userClientsRouter.get(
  "/me/client-access-requests",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ query: userListClientAccessRequestsQuerySchema }),
  asyncHandler(listMyClientAccessRequests),
);

/**
 * @openapi
 * /me/client-access-requests/{requestId}/approve:
 *   post:
 *     summary: Approve a client access request as authenticated owner
 *     description: Requires ownership of the request agent. Invalidates any pending public approval tokens for the request.
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Request approved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [approved, agentId, clientEmail]
 *               properties:
 *                 approved: { type: boolean }
 *                 agentId: { type: string, format: uuid }
 *                 clientEmail: { type: string, format: email }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       503:
 *         $ref: '#/components/responses/ServiceUnavailable'
 */
userClientsRouter.post(
  "/me/client-access-requests/:requestId/approve",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  meClientDecisionRateLimit,
  validateRequest({ params: userClientAccessRequestIdParamSchema }),
  asyncHandler(approveMyClientAccessRequest),
);

/**
 * @openapi
 * /me/client-access-requests/{requestId}/reject:
 *   post:
 *     summary: Reject a client access request as authenticated owner
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Request rejected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [rejected, agentId, clientEmail]
 *               properties:
 *                 rejected: { type: boolean }
 *                 agentId: { type: string, format: uuid }
 *                 clientEmail: { type: string, format: email }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       503:
 *         $ref: '#/components/responses/ServiceUnavailable'
 */
userClientsRouter.post(
  "/me/client-access-requests/:requestId/reject",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  meClientDecisionRateLimit,
  validateRequest({
    params: userClientAccessRequestIdParamSchema,
    body: userRejectClientAccessRequestBodySchema,
  }),
  asyncHandler(rejectMyClientAccessRequest),
);

/**
 * @openapi
 * /me/agents/{agentId}/clients:
 *   get:
 *     summary: List clients approved for an owned agent
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, blocked]
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
 *         description: Clients with approved access to the agent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [clients, count, total, page, pageSize]
 *               properties:
 *                 clients:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [clientId, email, name, lastName, status, approvedAt]
 *                     properties:
 *                       clientId: { type: string, format: uuid }
 *                       email: { type: string, format: email }
 *                       name: { type: string }
 *                       lastName: { type: string }
 *                       status: { type: string, enum: [active, blocked] }
 *                       approvedAt: { type: string, format: date-time }
 *                 count: { type: integer }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
userClientsRouter.get(
  "/me/agents/:agentId/clients",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ params: userAgentIdParamSchema, query: userListAgentClientsQuerySchema }),
  asyncHandler(listMyAgentClients),
);

/**
 * @openapi
 * /me/agents/{agentId}/clients/{clientId}:
 *   delete:
 *     summary: Revoke one client access from an owned agent
 *     description: >
 *       Idempotent. Removes `ClientAgentAccess`, marks paired `approved` request as `revoked`
 *       with reason `owner_revoked_access`, and disconnects matching `/consumers` sockets when access existed.
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Access revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [revoked, agentId, clientId]
 *               properties:
 *                 revoked: { type: boolean }
 *                 agentId: { type: string, format: uuid }
 *                 clientId: { type: string, format: uuid }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
userClientsRouter.delete(
  "/me/agents/:agentId/clients/:clientId",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ params: userAgentClientParamSchema }),
  asyncHandler(revokeMyAgentClientAccess),
);
