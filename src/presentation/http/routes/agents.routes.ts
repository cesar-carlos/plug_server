import { Router } from "express";

import { listConnectedAgents, proxyCommandToAgent } from "../controllers/agents.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuth } from "../middlewares/auth.middleware";
import { agentsCommandsRateLimit } from "../middlewares/rate_limit.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import { agentCommandBodySchema } from "../validators/agents.validator";

export const agentsRouter = Router();

/**
 * @openapi
 * /agents:
 *   get:
 *     summary: List all registered agents
 *     description: >
 *       Returns agents that have successfully emitted agent:register in the /agents Socket.IO namespace.
 *       Requires Bearer token. In non-production, includes _diagnostic.socketConnectionsInAgentsNamespace
 *       (raw socket count) to help debug when agents connect but do not register.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of registered agents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [agents, count]
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
 *                 _diagnostic:
 *                   type: object
 *                   description: Present only in non-production
 *                   properties:
 *                     socketConnectionsInAgentsNamespace:
 *                       type: integer
 *                       description: Raw socket count in /agents namespace (for debugging)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
agentsRouter.get("/", requireAuth, listConnectedAgents);

/**
 * @openapi
 * /agents/commands:
 *   post:
 *     summary: Proxy JSON-RPC command(s) to a connected agent
 *     description: >
 *       Authenticated HTTP bridge mode. The client sends `agentId` plus either a single JSON-RPC command
 *       object or a JSON-RPC batch array (max 32 items). The API forwards the payload to the connected
 *       agent over Socket.IO (/agents), waits for response when at least one command has non-null `id`,
 *       and returns a normalized response.
 *       Commands without `id` (or with `id: null`) are treated as notifications.
 *       Notification-only payloads return `202 Accepted` and do not wait for `rpc:response`.
 *       Top-level `pagination` is supported only for single `sql.execute` and is injected into
 *       `command.params.options` before dispatch.
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
 *             $ref: '#/components/schemas/AgentCommandRequest'
 *           examples:
 *             sqlExecuteWithMeta:
 *               summary: Single sql.execute with api_version/meta
 *               value:
 *                 agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *                 timeoutMs: 15000
 *                 command:
 *                   jsonrpc: "2.0"
 *                   method: "sql.execute"
 *                   id: "req-123"
 *                   api_version: "2.5"
 *                   meta:
 *                     traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
 *                     tracestate: "vendor=value"
 *                   params:
 *                     sql: "SELECT 1"
 *                     client_token: "token-value"
 *             sqlExecuteMultiResult:
 *               summary: Single sql.execute with multi_result enabled
 *               value:
 *                 agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *                 command:
 *                   jsonrpc: "2.0"
 *                   method: "sql.execute"
 *                   id: "multi-result-1"
 *                   params:
 *                     sql: "SELECT * FROM users; SELECT COUNT(*) AS orders_count FROM orders"
 *                     client_token: "token-value"
 *                     options:
 *                       multi_result: true
 *             sqlExecuteUpdate:
 *               summary: Single sql.execute with UPDATE
 *               value:
 *                 agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *                 command:
 *                   jsonrpc: "2.0"
 *                   method: "sql.execute"
 *                   id: "update-1"
 *                   params:
 *                     sql: "UPDATE users SET status = :status, updated_at = CURRENT_TIMESTAMP WHERE id = :id"
 *                     params:
 *                       id: 42
 *                       status: "inactive"
 *                     client_token: "token-value"
 *             sqlExecuteDelete:
 *               summary: Single sql.execute with DELETE
 *               value:
 *                 agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *                 command:
 *                   jsonrpc: "2.0"
 *                   method: "sql.execute"
 *                   id: "delete-1"
 *                   params:
 *                     sql: "DELETE FROM sessions WHERE expires_at < :cutoff"
 *                     params:
 *                       cutoff: "2026-03-01T00:00:00Z"
 *                     client_token: "token-value"
 *             sqlExecuteBatchDml:
 *               summary: sql.executeBatch with SELECT, INSERT, UPDATE and DELETE
 *               value:
 *                 agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *                 command:
 *                   jsonrpc: "2.0"
 *                   method: "sql.executeBatch"
 *                   id: "batch-dml-1"
 *                   params:
 *                     commands:
 *                       - sql: "SELECT id, status FROM users WHERE id = :id"
 *                         params:
 *                           id: 42
 *                         execution_order: 0
 *                       - sql: "INSERT INTO audit_logs (entity, entity_id, action) VALUES ('user', :id, 'status_change')"
 *                         params:
 *                           id: 42
 *                         execution_order: 1
 *                       - sql: "UPDATE users SET status = :status WHERE id = :id"
 *                         params:
 *                           id: 42
 *                           status: "inactive"
 *                         execution_order: 2
 *                       - sql: "DELETE FROM user_sessions WHERE user_id = :id"
 *                         params:
 *                           id: 42
 *                         execution_order: 3
 *                     client_token: "token-value"
 *                     options:
 *                       transaction: true
 *                       timeout_ms: 30000
 *             batchMixedNotification:
 *               summary: JSON-RPC batch with notification item
 *               value:
 *                 agentId: "3183a9f2-429b-46d6-a339-3580e5e5cb31"
 *                 command:
 *                   - jsonrpc: "2.0"
 *                     method: "sql.execute"
 *                     id: "batch-q1"
 *                     params:
 *                       sql: "SELECT 1"
 *                   - jsonrpc: "2.0"
 *                     method: "sql.execute"
 *                     params:
 *                       sql: "INSERT INTO logs (msg) VALUES ('ok')"
 *                   - jsonrpc: "2.0"
 *                     method: "sql.execute"
 *                     id: "batch-q2"
 *                     params:
 *                       sql: "SELECT 2"
 *     responses:
 *       200:
 *         description: Command proxied and normalized JSON-RPC response returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentCommandResponse200'
 *       202:
 *         description: Notification accepted (no JSON-RPC response expected)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentCommandResponse202'
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
  agentsCommandsRateLimit,
  validateRequest({ body: agentCommandBodySchema }),
  asyncHandler(proxyCommandToAgent),
);
