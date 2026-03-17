import { Router } from "express";

import {
  agentLogin,
  changePassword,
  getMe,
  login,
  logout,
  refresh,
  register,
} from "../controllers/auth.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuth } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  agentLoginBodySchema,
  changePasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from "../validators/auth.validator";

export const authRouter = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       409:
 *         description: Email already in use
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.post("/register", validateRequest({ body: registerBodySchema }), asyncHandler(register));

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Login with email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
authRouter.post("/login", validateRequest({ body: loginBodySchema }), asyncHandler(login));

/**
 * @openapi
 * /auth/agent-login:
 *   post:
 *     summary: Login for agents (Socket.IO namespace /agents)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, agentId]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *               agentId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Agent login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentAuthResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
authRouter.post(
  "/agent-login",
  validateRequest({ body: agentLoginBodySchema }),
  asyncHandler(agentLogin),
);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Rotate refresh token and issue new access token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New tokens issued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthTokens'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
authRouter.post("/refresh", validateRequest({ body: refreshBodySchema }), asyncHandler(refresh));

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Revoke the refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       204:
 *         description: Logged out successfully
 */
authRouter.post("/logout", validateRequest({ body: logoutBodySchema }), asyncHandler(logout));

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user info
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
authRouter.get("/me", requireAuth, asyncHandler(getMe));

/**
 * @openapi
 * /auth/password:
 *   patch:
 *     summary: Change password for authenticated user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       204:
 *         description: Password changed successfully
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.patch(
  "/password",
  requireAuth,
  validateRequest({ body: changePasswordBodySchema }),
  asyncHandler(changePassword),
);
