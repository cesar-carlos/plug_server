import { Router } from "express";

import { listConnectedAgents, proxyCommandToAgent } from "../controllers/agents.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuth } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import { agentCommandBodySchema } from "../validators/agents.validator";

export const agentsRouter = Router();

/**
 * @openapi
 * /agents:
 *   get:
 *     summary: List all connected socket clients (agents)
 *     description: Returns all agents currently connected in the /agents Socket.IO namespace. Requires authentication.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of connected agents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 agents:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       agentId:
 *                         type: string
 *                       socketId:
 *                         type: string
 *                       userId:
 *                         type: string
 *                         nullable: true
 *                       capabilities:
 *                         type: object
 *                       connectedAt:
 *                         type: string
 *                         format: date-time
 *                       lastSeenAt:
 *                         type: string
 *                         format: date-time
 *                 count:
 *                   type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
agentsRouter.get("/", requireAuth, listConnectedAgents);

/**
 * @openapi
 * /agents/commands:
 *   post:
 *     summary: Proxy a JSON-RPC command to a connected agent
 *     description: >
 *       Authenticated HTTP bridge mode. The client informs `agentId` and a JSON-RPC command.
 *       The API forwards the command to the connected agent over Socket.IO (namespace /agents),
 *       waits for the response, and returns a JSON response back to the client.
 *       When `pagination` is provided, the API injects pagination options into
 *       `command.params.options` before dispatching to the agent.
 *       Socket payload hardening is enabled in the bridge layer:
 *       compressed payload max 10MB, decoded payload max 10MB, max inflation ratio 20x,
 *       and optional HMAC signature verification when the frame includes `signature`.
 *       See `components.schemas.SocketBridgeSecurityNotes` for the documented hardening profile.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agentId, command]
 *             example:
 *               agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *               timeoutMs: 15000
 *               pagination:
 *                 page: 1
 *                 pageSize: 100
 *               command:
 *                 jsonrpc: "2.0"
 *                 method: "sql.execute"
 *                 id: "req-123"
 *                 params:
 *                   sql: "SELECT 1"
 *                   client_token: "token-value"
 *                   options:
 *                     page: 1
 *                     page_size: 100
 *             properties:
 *               agentId:
 *                 type: string
 *                 example: 3183a9f2-429b-46d6-a339-3580e5e5cb31
 *               timeoutMs:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 60000
 *                 example: 15000
 *               pagination:
 *                 type: object
 *                 description: >
 *                   Optional pagination passthrough for agent commands.
 *                   Use EITHER (`page` + `pageSize`) OR `cursor` — never both.
 *                 properties:
 *                   page:
 *                     type: integer
 *                     minimum: 1
 *                     example: 1
 *                   pageSize:
 *                     type: integer
 *                     minimum: 1
 *                     maximum: 50000
 *                     example: 100
 *                   cursor:
 *                     type: string
 *                     example: eyJ2IjoyLCJwYWdlIjoyfQ
 *               command:
 *                 type: object
 *                 required: [jsonrpc, method]
 *                 properties:
 *                   jsonrpc:
 *                     type: string
 *                     enum: ["2.0"]
 *                     example: "2.0"
 *                   method:
 *                     type: string
 *                     example: "sql.execute"
 *                   id:
 *                     oneOf:
 *                       - type: string
 *                       - type: number
 *                     example: "req-123"
 *                   params:
 *                     type: object
 *                     additionalProperties: true
 *                     example:
 *                       sql: "SELECT 1"
 *                       client_token: "token-value"
 *                       options:
 *                         page: 1
 *                         page_size: 100
 *     responses:
 *       200:
 *         description: Command proxied and agent response returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mode:
 *                   type: string
 *                   example: bridge
 *                 agentId:
 *                   type: string
 *                 requestId:
 *                   type: string
 *                 response:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [single, batch, raw]
 *                     success:
 *                       type: boolean
 *                     item:
 *                       type: object
 *                       properties:
 *                         id:
 *                           oneOf:
 *                             - type: string
 *                             - type: number
 *                           nullable: true
 *                         success:
 *                           type: boolean
 *                         result:
 *                           type: object
 *                           additionalProperties: true
 *                         error:
 *                           type: object
 *                           properties:
 *                             code:
 *                               type: integer
 *                             message:
 *                               type: string
 *                             data:
 *                               type: object
 *                               additionalProperties: true
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             oneOf:
 *                               - type: string
 *                               - type: number
 *                             nullable: true
 *                           success:
 *                             type: boolean
 *                           result:
 *                             type: object
 *                             additionalProperties: true
 *                           error:
 *                             type: object
 *                             properties:
 *                               code:
 *                                 type: integer
 *                               message:
 *                                 type: string
 *                               data:
 *                                 type: object
 *                                 additionalProperties: true
 *                     payload:
 *                       type: object
 *                       additionalProperties: true
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         description: Agent not found
 *       503:
 *         description: Agent offline, timed out, or payload signature/limits rejected
 */
agentsRouter.post(
  "/commands",
  requireAuth,
  validateRequest({ body: agentCommandBodySchema }),
  asyncHandler(proxyCommandToAgent),
);
