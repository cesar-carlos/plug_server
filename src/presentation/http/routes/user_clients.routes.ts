import { Router } from "express";

import {
  approveMyClientAccessRequest,
  getMyClient,
  listMyAgentClients,
  listMyClientAccessRequests,
  listMyClients,
  rejectMyClientAccessRequest,
  revokeMyAgentClientAccess,
  setMyClientStatus,
} from "../controllers/user_clients.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount, requireRole } from "../middlewares/auth.middleware";
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
 *     responses:
 *       200:
 *         description: Managed clients
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
 *     responses:
 *       200:
 *         description: Managed client
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
 *     summary: Update managed client status (active/blocked)
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Updated managed client
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
 * /me/client-access-requests:
 *   get:
 *     summary: List client access requests for agents owned by authenticated user
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Access requests
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
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Request approved
 */
userClientsRouter.post(
  "/me/client-access-requests/:requestId/approve",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
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
 *     responses:
 *       200:
 *         description: Request rejected
 */
userClientsRouter.post(
  "/me/client-access-requests/:requestId/reject",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
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
 *     responses:
 *       200:
 *         description: Clients approved for agent
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
 *     tags: [User clients]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Access revoked
 */
userClientsRouter.delete(
  "/me/agents/:agentId/clients/:clientId",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ params: userAgentClientParamSchema }),
  asyncHandler(revokeMyAgentClientAccess),
);
