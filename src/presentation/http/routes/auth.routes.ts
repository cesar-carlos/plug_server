import { Router } from "express";

import {
  agentLogin,
  approveRegistration,
  changePassword,
  getMe,
  login,
  logout,
  patchMe,
  refresh,
  register,
  registrationReviewPage,
  registrationStatus,
  rejectRegistration,
} from "../controllers/auth.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  agentLoginBodySchema,
  changePasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  patchMeBodySchema,
  refreshBodySchema,
  registerBodySchema,
  registrationApproveBodySchema,
  registrationRejectBodySchema,
  registrationTokenQuerySchema,
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
 *             required: [password]
 *             anyOf:
 *               - required: [email]
 *               - required: [username]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *               celular:
 *                 type: string
 *                 description: Optional Brazilian mobile only; normalized to E.164 on success. Must be unique among users when set.
 *     responses:
 *       201:
 *         description: Registration submitted; admin must approve before login
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [message, user]
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Registration pending approval
 *                 user:
 *                   type: object
 *                   required: [id, email, role, status]
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     email:
 *                       type: string
 *                       format: email
 *                     celular:
 *                       type: string
 *                       example: "+5511987654321"
 *                     role:
 *                       type: string
 *                     status:
 *                       type: string
 *                       example: pending
 *                 approvalToken:
 *                   type: string
 *                   description: Present only in non-production (local automation); opaque approval token
 *       409:
 *         description: Email or phone number already in use
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.post("/register", validateRequest({ body: registerBodySchema }), asyncHandler(register));

/**
 * @openapi
 * /auth/registration/review:
 *   get:
 *     summary: Admin review page (HTML) for pending registration
 *     description: Read-only page with POST forms to approve or reject. Does not mutate state on GET.
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 32
 *           maxLength: 128
 *           pattern: '^[A-Za-z0-9_-]+$'
 *     responses:
 *       200:
 *         description: HTML document with approve/reject forms
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.get(
  "/registration/review",
  validateRequest({ query: registrationTokenQuerySchema }),
  asyncHandler(registrationReviewPage),
);

/**
 * @openapi
 * /auth/registration/status:
 *   get:
 *     summary: Poll registration approval token state
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 32
 *           maxLength: 128
 *           pattern: '^[A-Za-z0-9_-]+$'
 *     responses:
 *       200:
 *         description: Token is still valid (pending) or past expiry (expired)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [pending, expired]
 *       404:
 *         description: Invalid token or already consumed
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.get(
  "/registration/status",
  validateRequest({ query: registrationTokenQuerySchema }),
  asyncHandler(registrationStatus),
);

/**
 * @openapi
 * /auth/registration/approve:
 *   post:
 *     summary: Approve a pending registration (activates the user)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 minLength: 32
 *                 maxLength: 128
 *                 pattern: '^[A-Za-z0-9_-]+$'
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Decision confirmation (HTML)
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Invalid or unknown token
 *       409:
 *         description: Registration already processed
 *       410:
 *         description: Approval link expired
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.post(
  "/registration/approve",
  validateRequest({ body: registrationApproveBodySchema }),
  asyncHandler(approveRegistration),
);

/**
 * @openapi
 * /auth/registration/reject:
 *   post:
 *     summary: Reject a pending registration
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 minLength: 32
 *                 maxLength: 128
 *                 pattern: '^[A-Za-z0-9_-]+$'
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *                 description: Optional message emailed to the user
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Decision confirmation (HTML)
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Invalid or unknown token
 *       409:
 *         description: Registration already processed
 *       410:
 *         description: Link expired
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
authRouter.post(
  "/registration/reject",
  validateRequest({ body: registrationRejectBodySchema }),
  asyncHandler(rejectRegistration),
);

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
 *     description: >
 *       Issues access/refresh tokens scoped to `agentId` for connecting to `/agents`.
 *       The user must already be linked to this `agentId` (typically admin user→agent API
 *       for the first link; self-service `POST /me/agents` can restore a link while the
 *       agent stays connected under your account).
 *       The `agentId` must exist in the agent catalog and have status `active`.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password, agentId]
 *             anyOf:
 *               - required: [email]
 *               - required: [username]
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
 *       403:
 *         description: >
 *           Forbidden — e.g. no user→agent binding, inactive agent, or agent bound to another user.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Agent not found in catalog
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
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
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
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
 *         description: Profile from database (id, email, status, celular) plus JWT context (role, agentId)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     sub: { type: string, description: Same as id (JWT compat) }
 *                     email: { type: string, format: email }
 *                     role: { type: string }
 *                     status: { type: string, enum: [pending, active, rejected, blocked] }
 *                     celular: { type: string, example: "+5511987654321" }
 *                     agentId: { type: string, format: uuid }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Account is blocked (or insufficient role on other routes using active-account check)
 *       404:
 *         description: User no longer exists
 */
authRouter.get("/me", ...requireAuthAndActiveAccount, asyncHandler(getMe));

/**
 * @openapi
 * /auth/me:
 *   patch:
 *     summary: Update current user profile (mobile number)
 *     description: >
 *       Set `celular` to a valid Brazilian mobile (normalized to E.164) or `null` to remove it.
 *       The number must be unique among users when set.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [celular]
 *             properties:
 *               celular:
 *                 oneOf:
 *                   - { type: string, description: Brazilian mobile, stored as E.164 }
 *                   - { type: "null", description: Remove stored mobile }
 *     responses:
 *       200:
 *         description: Updated profile (same shape as GET /auth/me)
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Account is blocked
 *       404:
 *         description: User no longer exists
 *       409:
 *         description: Phone number already in use
 */
authRouter.patch(
  "/me",
  ...requireAuthAndActiveAccount,
  validateRequest({ body: patchMeBodySchema }),
  asyncHandler(patchMe),
);

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
  ...requireAuthAndActiveAccount,
  validateRequest({ body: changePasswordBodySchema }),
  asyncHandler(changePassword),
);
