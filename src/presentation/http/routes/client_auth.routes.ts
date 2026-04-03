import { Router } from "express";

import {
  approveClientRegistration,
  changeClientPassword,
  clientRegistrationReviewPage,
  clientPasswordRecoveryReviewPage,
  clientPasswordRecoveryStatus,
  clientPasswordRecoveryRequest,
  clientPasswordRecoveryReset,
  clientRegistrationStatus,
  getClientMe,
  loginClient,
  logoutClient,
  patchClientMe,
  uploadClientThumbnail,
  refreshClient,
  rejectClientRegistration,
  registerClient,
} from "../controllers/client_auth.controller";
import { asyncHandler } from "../middlewares/async_handler";
import {
  clientPasswordRecoveryRequestRateLimit,
  clientThumbnailRateLimit,
} from "../middlewares/rate_limit.middleware";
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
  clientChangePasswordBodySchema,
  clientPatchMeBodySchema,
  clientPasswordRecoveryRequestBodySchema,
  clientPasswordRecoveryResetBodySchema,
  clientPasswordRecoveryTokenQuerySchema,
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
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientMeResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
clientAuthRouter.get("/me", ...requireClientAuthAndActiveAccount, asyncHandler(getClientMe));

/**
 * @openapi
 * /client-auth/me:
 *   patch:
 *     summary: Update current authenticated client profile
 *     description: >
 *       Updates profile fields for the authenticated client. To upload a new thumbnail image,
 *       use `POST /client-auth/thumbnail`. Send `thumbnailUrl: null` only to remove the current thumbnail.
 *     tags: [Client Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientPatchMeRequest'
 *     responses:
 *       200:
 *         description: Updated client profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientMeResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
clientAuthRouter.patch(
  "/me",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ body: clientPatchMeBodySchema }),
  asyncHandler(patchClientMe),
);

/**
 * @openapi
 * /client-auth/password:
 *   patch:
 *     summary: Change password for authenticated client
 *     tags: [Client Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientChangePasswordRequest'
 *     responses:
 *       204:
 *         description: Password changed successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
clientAuthRouter.patch(
  "/password",
  ...requireClientAuthAndActiveAccount,
  validateRequest({ body: clientChangePasswordBodySchema }),
  asyncHandler(changeClientPassword),
);

/**
 * @openapi
 * /client-auth/thumbnail:
 *   post:
 *     summary: Upload and persist client thumbnail
 *     description: >
 *       Accepts one image file in multipart field `thumbnail`, normalizes it on the server
 *       (resize/crop + convert to WebP), stores it, and returns the updated client profile.
 *     tags: [Client Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [thumbnail]
 *             properties:
 *               thumbnail:
 *                 type: string
 *                 format: binary
 *                 description: Image file (jpeg/png/webp/gif) up to configured size limit.
 *     responses:
 *       200:
 *         description: Updated client profile with thumbnail URL
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientMeResponse'
 *       400:
 *         description: Invalid image payload, unsupported type, or upload validation failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       429:
 *         description: Too many thumbnail uploads
 */
clientAuthRouter.post(
  "/thumbnail",
  ...requireClientAuthAndActiveAccount,
  clientThumbnailRateLimit,
  asyncHandler(uploadClientThumbnail),
);

/**
 * @openapi
 * /client-auth/password-recovery/request:
 *   post:
 *     summary: Request a password recovery email for client account
 *     tags: [Client Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientPasswordRecoveryRequest'
 *     responses:
 *       202:
 *         description: Request accepted (generic response)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientPasswordRecoveryRequestAccepted'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         description: Too many password recovery requests
 */
clientAuthRouter.post(
  "/password-recovery/request",
  clientPasswordRecoveryRequestRateLimit,
  validateRequest({ body: clientPasswordRecoveryRequestBodySchema }),
  asyncHandler(clientPasswordRecoveryRequest),
);

/**
 * @openapi
 * /client-auth/password-recovery/review:
 *   get:
 *     summary: Render password recovery review/reset page
 *     tags: [Client Auth]
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
 *         description: HTML page
 */
clientAuthRouter.get(
  "/password-recovery/review",
  validateRequest({ query: clientPasswordRecoveryTokenQuerySchema }),
  asyncHandler(clientPasswordRecoveryReviewPage),
);

/**
 * @openapi
 * /client-auth/password-recovery/status:
 *   get:
 *     summary: Read password recovery token status
 *     tags: [Client Auth]
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
 *         description: Token status payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientPasswordRecoveryStatusResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
clientAuthRouter.get(
  "/password-recovery/status",
  validateRequest({ query: clientPasswordRecoveryTokenQuerySchema }),
  asyncHandler(clientPasswordRecoveryStatus),
);

/**
 * @openapi
 * /client-auth/password-recovery/reset:
 *   post:
 *     summary: Reset client password by recovery token
 *     tags: [Client Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientPasswordRecoveryResetRequest'
 *     responses:
 *       204:
 *         description: Password reset successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       410:
 *         description: Recovery token expired
 */
clientAuthRouter.post(
  "/password-recovery/reset",
  validateRequest({ body: clientPasswordRecoveryResetBodySchema }),
  asyncHandler(clientPasswordRecoveryReset),
);
