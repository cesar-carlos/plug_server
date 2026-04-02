import { Router } from "express";

import {
  approveClientRegistration,
  clientRegistrationReviewPage,
  clientRegistrationStatus,
  getClientMe,
  loginClient,
  logoutClient,
  refreshClient,
  rejectClientRegistration,
  registerClient,
} from "../controllers/client_auth.controller";
import { asyncHandler } from "../middlewares/async_handler";
import {
  requireClientAuthAndActiveAccount,
} from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  clientRegistrationApproveBodySchema,
  clientRegistrationRejectBodySchema,
  clientRegistrationTokenQuerySchema,
  clientLoginBodySchema,
  clientLogoutBodySchema,
  clientRefreshBodySchema,
  clientRegisterBodySchema,
} from "../validators/client_auth.validator";

export const clientAuthRouter = Router();

/**
 * @openapi
 * /client-auth/register:
 *   post:
 *     summary: Request client registration linked to an owner user by email
 *     tags: [Client Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ownerEmail, email, password, name, lastName]
 *             properties:
 *               ownerEmail: { type: string, format: email }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               name: { type: string }
 *               lastName: { type: string }
 *               mobile: { type: string }
 *     responses:
 *       201:
 *         description: Client registration submitted and pending owner approval
 *       400:
 *         description: Owner email is not eligible to approve client registration
 *       409:
 *         description: Client email already in use
 */
clientAuthRouter.post(
  "/register",
  validateRequest({ body: clientRegisterBodySchema }),
  asyncHandler(registerClient),
);

/**
 * @openapi
 * /client-auth/registration/review:
 *   get:
 *     summary: Render review page for client registration token
 *     tags: [Client Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: HTML review page
 */
clientAuthRouter.get(
  "/registration/review",
  validateRequest({ query: clientRegistrationTokenQuerySchema }),
  asyncHandler(clientRegistrationReviewPage),
);

/**
 * @openapi
 * /client-auth/registration/status:
 *   get:
 *     summary: Read client registration status by token
 *     tags: [Client Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Status payload for current registration token
 */
clientAuthRouter.get(
  "/registration/status",
  validateRequest({ query: clientRegistrationTokenQuerySchema }),
  asyncHandler(clientRegistrationStatus),
);

/**
 * @openapi
 * /client-auth/registration/approve:
 *   post:
 *     summary: Approve pending client registration by token
 *     tags: [Client Auth]
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
clientAuthRouter.post(
  "/registration/approve",
  validateRequest({ body: clientRegistrationApproveBodySchema }),
  asyncHandler(approveClientRegistration),
);

/**
 * @openapi
 * /client-auth/registration/reject:
 *   post:
 *     summary: Reject pending client registration by token
 *     tags: [Client Auth]
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
clientAuthRouter.post(
  "/registration/reject",
  validateRequest({ body: clientRegistrationRejectBodySchema }),
  asyncHandler(rejectClientRegistration),
);

/**
 * @openapi
 * /client-auth/login:
 *   post:
 *     summary: Login with a client account
 *     tags: [Client Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Client authenticated
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
clientAuthRouter.post("/login", validateRequest({ body: clientLoginBodySchema }), asyncHandler(loginClient));

/**
 * @openapi
 * /client-auth/refresh:
 *   post:
 *     summary: Refresh a client session token
 *     tags: [Client Auth]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New access/refresh tokens issued
 *       400:
 *         description: Missing refresh token in body/cookie
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
clientAuthRouter.post("/refresh", validateRequest({ body: clientRefreshBodySchema }), asyncHandler(refreshClient));

/**
 * @openapi
 * /client-auth/logout:
 *   post:
 *     summary: Logout client (refresh token revoke)
 *     tags: [Client Auth]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       204:
 *         description: Logged out
 */
clientAuthRouter.post("/logout", validateRequest({ body: clientLogoutBodySchema }), asyncHandler(logoutClient));

/**
 * @openapi
 * /client-auth/me:
 *   get:
 *     summary: Get current authenticated client profile
 *     tags: [Client Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current client profile
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
clientAuthRouter.get("/me", ...requireClientAuthAndActiveAccount, asyncHandler(getClientMe));
