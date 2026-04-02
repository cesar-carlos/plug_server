import { Router } from "express";

import {
  getClientMe,
  loginClient,
  logoutClient,
  refreshClient,
  registerClient,
} from "../controllers/client_auth.controller";
import { asyncHandler } from "../middlewares/async_handler";
import {
  requireAuthAndActiveAccount,
  requireClientAuthAndActiveAccount,
  requireRole,
} from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
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
 *     summary: Register a client account linked to the authenticated owner user
 *     tags: [Client Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, name, lastName]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               name: { type: string }
 *               lastName: { type: string }
 *               mobile: { type: string }
 *     responses:
 *       201:
 *         description: Client registered and authenticated
 *       404:
 *         description: Owner user not found
 *       409:
 *         description: Client email already in use
 */
clientAuthRouter.post(
  "/register",
  ...requireAuthAndActiveAccount,
  requireRole("user", "admin"),
  validateRequest({ body: clientRegisterBodySchema }),
  asyncHandler(registerClient),
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
