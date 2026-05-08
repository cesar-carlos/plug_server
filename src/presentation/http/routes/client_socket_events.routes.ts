import { Router } from "express";

import {
  clientSocketEventUpload,
  publishClientSocketEvent,
  validateClientSocketEventPublishRequest,
  wrapClientSocketEventMulterErrors,
} from "../controllers/client_socket_events.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireClientAuthAndActiveAccount } from "../middlewares/auth.middleware";
import { clientSocketEventPublishRateLimit } from "../middlewares/rate_limit.middleware";

export const clientSocketEventsRouter = Router();

/**
 * @openapi
 * /client/me/socket-events:
 *   post:
 *     summary: Publish a custom Socket event to subscribed consumers
 *     description: >
 *       Publishes a custom `client:custom.*` event to every authenticated `/consumers`
 *       socket currently subscribed through `socket:event.subscribe` on this hub instance.
 *       The server emits the dynamic event name with a PayloadFrame containing the logical
 *       payload and optional inline attachments. The route confirms local emission only;
 *       it does not wait for listener-level acknowledgement.
 *     tags: [Client Socket Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: >
 *           Optional retry key. Reusing the same key with the same body returns the original
 *           202 response without emitting the Socket event again.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientSocketEventPublishRequest'
 *           examples:
 *             status:
 *               value:
 *                 eventName: client:custom.status.changed
 *                 payloadFrameCompression: default
 *                 payload:
 *                   status: ready
 *                   message: Background job finished
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/ClientSocketEventMultipartPublishRequest'
 *           encoding:
 *             event:
 *               contentType: application/json
 *     responses:
 *       202:
 *         description: Event accepted and emitted to current local subscribers
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClientSocketEventPublishResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       409:
 *         description: Idempotency-Key was reused with a different request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       413:
 *         description: Payload or attachment limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       503:
 *         description: Local custom event fan-out limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
clientSocketEventsRouter.post(
  "/client/me/socket-events",
  ...requireClientAuthAndActiveAccount,
  clientSocketEventPublishRateLimit,
  wrapClientSocketEventMulterErrors(clientSocketEventUpload.array("files")),
  validateClientSocketEventPublishRequest,
  asyncHandler(publishClientSocketEvent),
);
