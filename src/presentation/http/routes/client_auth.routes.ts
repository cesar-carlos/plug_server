import cookieParser from "cookie-parser";
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
  clientThumbnailUpload,
  getClientMe,
  loginClient,
  logoutClient,
  patchClientMe,
  uploadClientThumbnail,
  refreshClient,
  rejectClientRegistration,
  registerClient,
  retryClientRegistration,
  wrapMulterErrors,
} from "../controllers/client_auth.controller";
import { asyncHandler } from "../middlewares/async_handler";
import {
  clientPasswordRecoveryRequestRateLimit,
  clientThumbnailRateLimit,
  credentialAuthRateLimit,
  loginRateLimit,
  tokenRefreshRateLimit,
} from "../middlewares/rate_limit.middleware";
import { requireClientAuthAndActiveAccount } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  clientRegistrationApproveBodySchema,
  clientRegistrationRejectBodySchema,
  clientRegistrationRetryBodySchema,
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
 * Only `/client-auth/refresh` and `/client-auth/logout` consume
 * `req.cookies.client_refresh_token`. Same rationale as `authRouter`:
 * scope the cookie parser to where cookies are actually read.
 */
clientAuthRouter.use(cookieParser());

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
  credentialAuthRateLimit,
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
  credentialAuthRateLimit,
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
 *         description: Registration poll status for the token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [pending, expired, approved, rejected, blocked]
 *       404:
 *         description: Unknown token or orphaned token (client row missing)
 */
clientAuthRouter.get(
  "/registration/status",
  credentialAuthRateLimit,
  validateRequest({ query: clientRegistrationTokenQuerySchema }),
  asyncHandler(clientRegistrationStatus),
);

/**
 * @openapi
 * /client-auth/registration/retry:
 *   post:
 *     summary: Retry a rejected client registration approval request
 *     description: Always returns a generic 202 response; when eligible, reopens the client registration and emails a new owner approval link.
 *     tags: [Client Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ownerEmail, email, password]
 *             properties:
 *               ownerEmail:
 *                 type: string
 *                 format: email
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 1
 *     responses:
 *       202:
 *         description: Retry accepted generically
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [message]
 *               properties:
 *                 message:
 *                   type: string
 *                   example: If eligible, a new approval request will be sent.
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 */
clientAuthRouter.post(
  "/registration/retry",
  credentialAuthRateLimit,
  validateRequest({ body: clientRegistrationRetryBodySchema }),
  asyncHandler(retryClientRegistration),
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
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: HTML confirmation page (approved)
 *         content:
 *           text/html: { schema: { type: string } }
 *       400:
 *         description: Validation error (JSON) or HTML for browser form posts
 *       404:
 *         description: Invalid or unknown token
 */
clientAuthRouter.post(
  "/registration/approve",
  credentialAuthRateLimit,
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
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       200:
 *         description: HTML confirmation page (rejected)
 *         content:
 *           text/html: { schema: { type: string } }
 *       400:
 *         description: Validation error (JSON) or HTML for browser form posts
 *       404:
 *         description: Invalid or unknown token
 */
clientAuthRouter.post(
  "/registration/reject",
  credentialAuthRateLimit,
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
clientAuthRouter.post(
  "/login",
  loginRateLimit,
  validateRequest({ body: clientLoginBodySchema }),
  asyncHandler(loginClient),
);

/**
 * @openapi
 * /client-auth/refresh:
 *   post:
 *     summary: Refresh a client session token
 *     description: >
 *       Rate-limited with `REST_TOKEN_REFRESH_RATE_LIMIT_*` (same as `/auth/refresh`),
 *       separate from the credential limiter used on `/client-auth/login`.
 *       Refresh token transport follows `RefreshTokenTransport`: JSON body and/or HttpOnly
 *       `client_refresh_token` cookie. When both are sent, **body > cookie** (non-empty body wins).
 *     tags: [Client Auth]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RefreshTokenTransport'
 *     responses:
 *       200:
 *         description: New access/refresh tokens issued
 *       400:
 *         description: Missing refresh token in body/cookie
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
clientAuthRouter.post(
  "/refresh",
  tokenRefreshRateLimit,
  validateRequest({ body: clientRefreshBodySchema }),
  asyncHandler(refreshClient),
);

/**
 * @openapi
 * /client-auth/logout:
 *   post:
 *     summary: Logout client (refresh token revoke)
 *     description: >
 *       Accepts the refresh token via JSON body and/or HttpOnly `client_refresh_token` cookie.
 *       When both are sent, **body > cookie** (non-empty body wins). The cookie is always
 *       cleared in the response even when revocation fails or no token is supplied.
 *     tags: [Client Auth]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RefreshTokenTransport'
 *     responses:
 *       204:
 *         description: Logged out
 */
clientAuthRouter.post(
  "/logout",
  credentialAuthRateLimit,
  validateRequest({ body: clientLogoutBodySchema }),
  asyncHandler(logoutClient),
);

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
  wrapMulterErrors(clientThumbnailUpload.single("thumbnail")),
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
 *       429:
 *         description: Too many password recovery token checks
 */
clientAuthRouter.get(
  "/password-recovery/review",
  clientPasswordRecoveryRequestRateLimit,
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
 *       429:
 *         description: Too many password recovery token checks
 */
clientAuthRouter.get(
  "/password-recovery/status",
  clientPasswordRecoveryRequestRateLimit,
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
  credentialAuthRateLimit,
  validateRequest({ body: clientPasswordRecoveryResetBodySchema }),
  asyncHandler(clientPasswordRecoveryReset),
);
