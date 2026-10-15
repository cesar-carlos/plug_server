import { Router } from "express";
import {
  createClientDelegation,
  revokeClientDelegation,
  verifyClientDelegation,
} from "../controllers/client_delegation.controller";
import { requireClientAuthAndFreshActiveAccount } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import { asyncHandler } from "../middlewares/async_handler";
import { credentialAuthRateLimit } from "../middlewares/rate_limit.middleware";
import {
  clientDelegationBody,
  clientDelegationBinding,
  clientDelegationParams,
} from "../validators/client_delegation.validator";
export const clientDelegationRouter = Router();
/**
 * @openapi
 * /client-auth/persona-delegations:
 *   post:
 *     summary: Issue a 30-day revocable proof of active Client for one persona and MCP origin
 *     tags: [Client Auth]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [audience, personaId]
 *             additionalProperties: false
 *             properties:
 *               audience: { type: string, format: uri, maxLength: 2048 }
 *               personaId: { type: string, format: uuid }
 *               administrative:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 5
 *                 uniqueItems: true
 *                 default: [gerenciar_fontes]
 *                 items: { type: string, enum: [treinar, publicar, gerenciar_fontes, gerenciar_tokens, gerenciar_integracoes] }
 *     responses:
 *       201:
 *         description: Credential returned once; hash only stored. Cannot authenticate JWT routes or approve operations.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [id, clientId, audience, personaId, expiresAt, administrative, credential]
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     clientId: { type: string }
 *                     audience: { type: string }
 *                     personaId: { type: string }
 *                     expiresAt: { type: string, format: date-time }
 *                     administrative:
 *                       type: array
 *                       items: { type: string, enum: [treinar, publicar, gerenciar_fontes, gerenciar_tokens, gerenciar_integracoes] }
 *                     credential: { type: string }
 * /client-auth/persona-delegations/verify:
 *   post:
 *     summary: Verify the opaque delegation and active Client without issuing a JWT
 *     tags: [Client Auth]
 *     description: Dedicated Bearer pdv2 credential; exact audience/persona required. No caching or agent access.
 *     security: []
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema: { type: string, pattern: '^Bearer pdv2_[A-Za-z0-9_-]{43}$' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [audience, personaId]
 *             properties:
 *               audience: { type: string, format: uri }
 *               personaId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Active proof with identity, bindings and expiry; no credentials
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [id, clientId, audience, personaId, expiresAt, administrative, active]
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     clientId: { type: string }
 *                     audience: { type: string }
 *                     personaId: { type: string }
 *                     expiresAt: { type: string, format: date-time }
 *                     administrative:
 *                       type: array
 *                       items: { type: string, enum: [treinar, publicar, gerenciar_fontes, gerenciar_tokens, gerenciar_integracoes] }
 *                     active: { type: boolean, enum: [true] }
 * /client-auth/persona-delegations/{id}:
 *   delete:
 *     summary: Revoke an owned delegation; revocation cannot be undone
 *     tags: [Client Auth]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Revoked
 */
clientDelegationRouter.post(
  "/",
  ...requireClientAuthAndFreshActiveAccount,
  credentialAuthRateLimit,
  validateRequest({ body: clientDelegationBody }),
  asyncHandler(createClientDelegation),
);
clientDelegationRouter.post(
  "/verify",
  credentialAuthRateLimit,
  validateRequest({ body: clientDelegationBinding }),
  asyncHandler(verifyClientDelegation),
);
clientDelegationRouter.delete(
  "/:id",
  ...requireClientAuthAndFreshActiveAccount,
  credentialAuthRateLimit,
  validateRequest({ params: clientDelegationParams }),
  asyncHandler(revokeClientDelegation),
);
