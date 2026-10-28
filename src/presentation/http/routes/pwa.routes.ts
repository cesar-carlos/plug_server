import { Router } from "express";
import {
  issuePwaOfflineAuthorization,
  getPwaPushKey,
  putPwaSubscription,
  deletePwaSubscription,
} from "../controllers/pwa.controller";
import { requireClientAuthAndFreshActiveAccount } from "../middlewares/auth.middleware";
import { credentialAuthRateLimit } from "../middlewares/rate_limit.middleware";
import { asyncHandler } from "../middlewares/async_handler";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  pwaOfflineAuthorizationBody,
  pwaInstallationParams,
  pwaSubscriptionBody,
} from "../validators/pwa.validator";

export const pwaRouter = Router();
/**
 * @openapi
 * /client/me/pwa/offline-authorization:
 *   post:
 *     summary: Issue a 24-hour local-read authorization for approved active agents
 *     tags: [Client PWA]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [agentIds]
 *             properties:
 *               agentIds:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 uniqueItems: true
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Success envelope containing version, userId, agentIds, issuedAt and expiresAt; not an API credential
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Account or agent access denied
 */
pwaRouter.post(
  "/offline-authorization",
  ...requireClientAuthAndFreshActiveAccount,
  credentialAuthRateLimit,
  validateRequest({ body: pwaOfflineAuthorizationBody }),
  asyncHandler(issuePwaOfflineAuthorization),
);

/**
 * @openapi
 * /client/me/pwa/push-key:
 *   get:
 *     summary: Read Web Push availability and the public VAPID key
 *     tags: [Client PWA]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Success envelope with enabled and publicKey; no-store }
 *       401: { description: Authentication required }
 * /client/me/pwa/subscriptions/{installationId}:
 *   parameters:
 *     - in: path
 *       name: installationId
 *       required: true
 *       schema: { type: string, format: uuid }
 *   put:
 *     summary: Register this authenticated client's browser installation
 *     tags: [Client PWA]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [endpoint, keys]
 *             properties:
 *               endpoint: { type: string, format: uri, maxLength: 2048 }
 *               keys:
 *                 type: object
 *                 additionalProperties: false
 *                 required: [p256dh, auth]
 *                 properties:
 *                   p256dh: { type: string, minLength: 87, maxLength: 87 }
 *                   auth: { type: string, minLength: 22, maxLength: 22 }
 *     responses:
 *       204: { description: Subscription saved }
 *       400: { description: Invalid subscription or unsupported provider endpoint }
 *       401: { description: Authentication required }
 *       409: { description: Installation or endpoint belongs to a different registration }
 *       503: { description: Web Push not configured }
 *   delete:
 *     summary: Remove the authenticated client's installation and cancel pending delivery
 *     tags: [Client PWA]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Removed or already absent }
 *       401: { description: Authentication required }
 */
pwaRouter.get(
  "/push-key",
  ...requireClientAuthAndFreshActiveAccount,
  credentialAuthRateLimit,
  asyncHandler(getPwaPushKey),
);
pwaRouter.put(
  "/subscriptions/:installationId",
  ...requireClientAuthAndFreshActiveAccount,
  credentialAuthRateLimit,
  validateRequest({ params: pwaInstallationParams, body: pwaSubscriptionBody }),
  asyncHandler(putPwaSubscription),
);
pwaRouter.delete(
  "/subscriptions/:installationId",
  ...requireClientAuthAndFreshActiveAccount,
  credentialAuthRateLimit,
  validateRequest({ params: pwaInstallationParams }),
  asyncHandler(deletePwaSubscription),
);
