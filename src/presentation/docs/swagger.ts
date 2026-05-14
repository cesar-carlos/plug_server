import type { Express } from "express";
import swaggerJSDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import path from "node:path";

import pkg from "../../../package.json";
import { env } from "../../shared/config/env";
import {
  HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES,
  HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO,
} from "../../shared/constants/agent_transport_contract";
import {
  AGENT_CLIENT_TOKEN_CARRIER_PARAMS_JSON_MAX_BYTES,
  AGENT_MAX_ROWS_LIMIT,
  AGENT_PAGE_SIZE_LIMIT,
  AGENT_RPC_DISCOVER_PARAMS_JSON_MAX_BYTES,
  AGENT_SQL_MAX_UTF8_BYTES,
  AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES,
  AGENT_TIMEOUT_MS_LIMIT,
} from "../../shared/validators/agent_command";

const routeDocGlobs =
  env.nodeEnv === "production"
    ? [path.join(process.cwd(), "dist/presentation/http/routes/**/*.js")]
    : [path.join(process.cwd(), "src/presentation/http/routes/**/*.ts")];

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: `${env.appName} API`,
      version: pkg.version,
      description: `REST API documentation for ${env.appName}. The HTTP API fronts a dual-namespace Socket.IO architecture: agents connect to /agents, consumers to /consumers. The default namespace (/) is deprecated and rejects connections with app:error (code NAMESPACE_DEPRECATED). Compatibility aliases /auth/* and /metrics are also mounted at the root.`,
    },
    servers: [
      {
        url: "/api/v1",
        description: "Current environment",
      },
    ],
    tags: [
      { name: "Health", description: "Liveness, readiness and Prometheus metrics" },
      { name: "Auth", description: "User authentication and registration approval" },
      { name: "Client Auth", description: "Colmeia client authentication and registration" },
      { name: "Agents", description: "Agent commands and HTTP-to-Socket bridge" },
      { name: "Agent catalog", description: "Agent catalog read and filter" },
      { name: "User agents", description: "User-to-agent binding management" },
      { name: "Client Agent Access", description: "Client-to-agent access requests and approvals" },
      {
        name: "Client Socket Events",
        description: "REST-published custom events for /consumers subscribers",
      },
      { name: "User clients", description: "Owner management of managed clients" },
      { name: "Admin", description: "Admin-only operations (user status, blocking)" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your access token in the format: Bearer <token>",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["success", "message", "code", "error"],
          properties: {
            success: { type: "boolean", enum: [false], example: false },
            message: { type: "string", example: "Invalid or expired token" },
            code: { type: "string", example: "INVALID_TOKEN" },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", example: "INVALID_TOKEN" },
                message: { type: "string", example: "Invalid or expired token" },
                details: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            },
            requestId: { type: "string", example: "0d2a9475-ccf8-4f03-a64c-ef75f9b2f5c6" },
            details: {
              type: "object",
              description:
                "Optional payload for specific codes (non-production may echo more fields). Example: `AGENT_NOT_ONLINE_FOR_USER` includes `reason`: `offline` | `different_account`.",
              additionalProperties: true,
            },
          },
        },
        ValidationErrorResponse: {
          allOf: [
            { $ref: "#/components/schemas/ErrorResponse" },
            {
              type: "object",
              properties: {
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      field: { type: "string", example: "email" },
                      message: { type: "string", example: "Must be a valid email address" },
                    },
                  },
                },
              },
            },
          ],
        },
        ClientSocketEventPublishRequest: {
          type: "object",
          required: ["eventName", "payload"],
          additionalProperties: false,
          description:
            "Same logical fields as `socket:event.publish` on `/consumers` for `Client` JWTs. REST uses HTTP rate limits (`REST_SOCKET_EVENT_RATE_LIMIT_*`). Socket uses a separate counter; defaults mirror those env vars, with optional overrides `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_*` (see `docs/configuration.md`).",
          properties: {
            eventName: {
              type: "string",
              pattern: "^client:custom\\.",
              maxLength: 128,
              example: "client:custom.status.changed",
              description:
                "Custom event name. Only the reserved client:custom.* prefix is accepted; internal Socket protocol events are blocked.",
            },
            payload: {
              description: "JSON payload delivered inside the outbound PayloadFrame.",
              nullable: true,
            },
            payloadFrameCompression: {
              type: "string",
              enum: ["default", "none", "always"],
              default: "default",
              description:
                "Compression policy used when the hub emits the PayloadFrame to subscribed consumers.",
            },
          },
        },
        ClientSocketEventMultipartPublishRequest: {
          type: "object",
          required: ["event"],
          properties: {
            event: {
              type: "string",
              description:
                "JSON string matching ClientSocketEventPublishRequest. Files are sent in repeated `files` fields and delivered as inline base64 attachments.",
              example:
                '{"eventName":"client:custom.document.ready","payload":{"documentId":"doc-1"},"payloadFrameCompression":"default"}',
            },
            files: {
              type: "array",
              items: { type: "string", format: "binary" },
            },
          },
        },
        ClientSocketEventPublishResponse: {
          type: "object",
          required: ["success", "eventId", "eventName", "recipients"],
          properties: {
            success: { type: "boolean", enum: [true] },
            eventId: { type: "string", format: "uuid" },
            eventName: { type: "string", example: "client:custom.status.changed" },
            recipients: {
              type: "integer",
              minimum: 0,
              description:
                "Number of local sockets subscribed to the event on this hub instance at publish time.",
            },
            requestId: { type: "string" },
            idempotencyKey: {
              type: "string",
              description: "Echoed when the request used Idempotency-Key.",
            },
            idempotentReplay: {
              type: "boolean",
              description:
                "True when this response was replayed from the Idempotency-Key cache without emitting a duplicate Socket event.",
            },
          },
        },
        AuthUser: {
          type: "object",
          required: ["id", "email", "role"],
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            role: { type: "string", example: "user" },
          },
        },
        AuthTokens: {
          type: "object",
          required: ["accessToken", "refreshToken", "success", "token"],
          properties: {
            accessToken: { type: "string" },
            refreshToken: { type: "string" },
            success: { type: "boolean", example: true },
            token: { type: "string", description: "Alias for accessToken" },
          },
        },
        AuthResponse: {
          allOf: [
            { $ref: "#/components/schemas/AuthTokens" },
            {
              type: "object",
              required: ["user"],
              properties: {
                user: { $ref: "#/components/schemas/AuthUser" },
              },
            },
          ],
        },
        AuthChangePasswordRequest: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string" },
            newPassword: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
        AgentAuthUser: {
          type: "object",
          required: ["id", "email", "role", "agentId"],
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["agent"] },
            agentId: { type: "string", format: "uuid" },
          },
        },
        AgentAuthResponse: {
          allOf: [
            { $ref: "#/components/schemas/AuthTokens" },
            {
              type: "object",
              required: ["user"],
              properties: {
                user: { $ref: "#/components/schemas/AgentAuthUser" },
              },
            },
          ],
        },
        ClientAuthUser: {
          type: "object",
          required: ["id", "userId", "email", "name", "lastName", "status", "role"],
          properties: {
            id: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            name: { type: "string", maxLength: 120 },
            lastName: { type: "string", maxLength: 120 },
            mobile: { type: "string", nullable: true, example: "+5511912345678" },
            thumbnailUrl: {
              type: "string",
              format: "uri",
              nullable: true,
              description: "Normalized thumbnail URL generated by the server.",
            },
            status: { type: "string", enum: ["pending", "active", "rejected", "blocked"] },
            role: { type: "string", enum: ["client"] },
          },
        },
        ClientAuthResponse: {
          allOf: [
            { $ref: "#/components/schemas/AuthTokens" },
            {
              type: "object",
              required: ["client"],
              properties: {
                client: { $ref: "#/components/schemas/ClientAuthUser" },
              },
            },
          ],
        },
        ClientMeResponse: {
          type: "object",
          required: ["client"],
          properties: {
            client: { $ref: "#/components/schemas/ClientAuthUser" },
          },
        },
        ClientPatchMeRequest: {
          type: "object",
          description:
            "Partial profile update. `thumbnailUrl: null` removes the current thumbnail; new thumbnails must be uploaded via `/client-auth/thumbnail`.",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            lastName: { type: "string", minLength: 1, maxLength: 120 },
            mobile: {
              oneOf: [
                { type: "string", description: "Brazilian mobile number; normalized to E.164." },
                { type: "null", description: "Remove stored mobile number." },
              ],
            },
            thumbnailUrl: {
              type: "null",
              description:
                "Remove current thumbnail. Use `/client-auth/thumbnail` to upload a new one.",
            },
          },
          additionalProperties: false,
        },
        ClientChangePasswordRequest: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string" },
            newPassword: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
        ClientPasswordRecoveryRequest: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
          },
        },
        ClientPasswordRecoveryRequestAccepted: {
          type: "object",
          required: ["message"],
          properties: {
            message: {
              type: "string",
              example: "If the account exists, a password recovery email will be sent shortly.",
            },
          },
        },
        ClientPasswordRecoveryStatusResponse: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["pending", "expired"] },
          },
        },
        ClientPasswordRecoveryResetRequest: {
          type: "object",
          required: ["token", "newPassword"],
          properties: {
            token: {
              type: "string",
              minLength: 32,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_-]+$",
            },
            newPassword: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
        SocketBridgeSecurityNotes: {
          type: "object",
          description:
            "Security and transport hardening notes applied to HTTP-to-Socket bridge flow.",
          properties: {
            maxCompressedPayloadBytes: {
              type: "integer",
              example: 10485760,
              description: "Maximum accepted compressed PayloadFrame size in bytes.",
            },
            maxDecodedPayloadBytes: {
              type: "integer",
              example: 10485760,
              description: "Maximum accepted decoded PayloadFrame size in bytes.",
            },
            maxInflationRatio: {
              type: "number",
              example: HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO,
              description: "Maximum allowed decoded/compressed ratio for gzip frames.",
            },
            signatureVerification: {
              type: "object",
              properties: {
                enabledWhenSignaturePresent: {
                  type: "boolean",
                  example: true,
                },
                algorithm: {
                  type: "string",
                  example: "hmac-sha256",
                },
                requiredEnv: {
                  type: "array",
                  items: { type: "string" },
                  example: ["PAYLOAD_SIGNING_KEY", "PAYLOAD_SIGNING_KEY_ID"],
                },
              },
            },
          },
        },
        JsonRpcId: {
          description:
            "JSON-RPC request id. Omit: hub assigns a UUID before forwarding (await response). null: JSON-RPC notification (no response). String or number: forwarded as-is.",
          nullable: true,
          oneOf: [{ type: "string", minLength: 1 }, { type: "number" }],
        },
        RpcMeta: {
          type: "object",
          description:
            "Bridge input metadata. The hub forwards only the published plug_agente fields (`trace_id`, `traceparent`, `tracestate`, `request_id`, `agent_id`, `timestamp`) to the agent; compatibility-only fields like `outbound_compression` are accepted on input but stripped before forwarding.",
          properties: {
            trace_id: { type: "string" },
            traceparent: { type: "string" },
            tracestate: { type: "string" },
            request_id: { type: "string" },
            agent_id: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
            outbound_compression: {
              type: "string",
              enum: ["none", "gzip", "auto"],
              description:
                "Compatibility-only input accepted by the hub for older clients. It is not forwarded to plug_agente because the published transport contract does not support per-request compression overrides.",
            },
          },
          additionalProperties: true,
        },
        SqlExecuteOptions: {
          type: "object",
          description: `Numeric limits match Zod validation: timeout_ms max ${AGENT_TIMEOUT_MS_LIMIT}, max_rows max ${AGENT_MAX_ROWS_LIMIT}, page_size max ${AGENT_PAGE_SIZE_LIMIT}.`,
          properties: {
            timeout_ms: { type: "integer", minimum: 1, maximum: AGENT_TIMEOUT_MS_LIMIT },
            max_rows: { type: "integer", minimum: 1, maximum: AGENT_MAX_ROWS_LIMIT },
            page: { type: "integer", minimum: 1 },
            page_size: { type: "integer", minimum: 1, maximum: AGENT_PAGE_SIZE_LIMIT },
            cursor: { type: "string", minLength: 1 },
            execution_mode: {
              type: "string",
              enum: ["managed", "preserve"],
              description:
                "SQL handling mode. managed (default) allows agent-managed pagination rewriting. preserve executes SQL exactly as sent. Cannot be combined with page, page_size or cursor.",
            },
            preserve_sql: {
              type: "boolean",
              description:
                "Deprecated alias for execution_mode=preserve. Cannot be combined with page, page_size or cursor.",
            },
            multi_result: { type: "boolean" },
          },
          additionalProperties: false,
        },
        SqlExecuteParams: {
          type: "object",
          required: ["sql"],
          description: `Logical JSON limits before PayloadFrame (UTF-8 bytes): \`sql\` max ${AGENT_SQL_MAX_UTF8_BYTES}; serialized \`params\` max ${AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES}.`,
          properties: {
            sql: {
              type: "string",
              minLength: 1,
              description: `Max ${AGENT_SQL_MAX_UTF8_BYTES} UTF-8 bytes (matches Zod).`,
            },
            params: {
              type: "object",
              additionalProperties: true,
              description: `Named parameters; JSON max ${AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES} UTF-8 bytes when serialized.`,
            },
            client_token: { type: "string", minLength: 1 },
            clientToken: { type: "string", minLength: 1 },
            auth: { type: "string", minLength: 1 },
            idempotency_key: { type: "string", minLength: 1 },
            database: { type: "string", minLength: 1 },
            options: { $ref: "#/components/schemas/SqlExecuteOptions" },
          },
          additionalProperties: false,
        },
        SqlExecuteBatchCommandItem: {
          type: "object",
          required: ["sql"],
          properties: {
            sql: {
              type: "string",
              minLength: 1,
              description: `Max ${AGENT_SQL_MAX_UTF8_BYTES} UTF-8 bytes per command (matches Zod).`,
            },
            params: {
              type: "object",
              additionalProperties: true,
              description: `JSON max ${AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES} UTF-8 bytes when serialized.`,
            },
            execution_order: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        SqlExecuteBatchOptions: {
          type: "object",
          description: `timeout_ms max ${AGENT_TIMEOUT_MS_LIMIT} and max_rows max ${AGENT_MAX_ROWS_LIMIT}, same as sql.execute options.`,
          properties: {
            timeout_ms: { type: "integer", minimum: 1, maximum: AGENT_TIMEOUT_MS_LIMIT },
            max_rows: { type: "integer", minimum: 1, maximum: AGENT_MAX_ROWS_LIMIT },
            transaction: { type: "boolean" },
          },
          additionalProperties: false,
        },
        SqlExecuteBatchParams: {
          type: "object",
          required: ["commands"],
          properties: {
            commands: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: { $ref: "#/components/schemas/SqlExecuteBatchCommandItem" },
            },
            client_token: { type: "string", minLength: 1 },
            clientToken: { type: "string", minLength: 1 },
            auth: { type: "string", minLength: 1 },
            idempotency_key: { type: "string", minLength: 1 },
            database: { type: "string", minLength: 1 },
            options: { $ref: "#/components/schemas/SqlExecuteBatchOptions" },
          },
          additionalProperties: false,
        },
        SqlBulkInsertColumn: {
          type: "object",
          required: ["name", "type"],
          properties: {
            name: { type: "string", minLength: 1 },
            type: {
              type: "string",
              enum: ["i32", "i64", "text", "decimal", "binary", "timestamp"],
            },
            nullable: { type: "boolean" },
            max_len: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        SqlBulkInsertOptions: {
          type: "object",
          description: `timeout_ms max ${AGENT_TIMEOUT_MS_LIMIT}, same as sql.execute options.`,
          properties: {
            timeout_ms: { type: "integer", minimum: 1, maximum: AGENT_TIMEOUT_MS_LIMIT },
          },
          additionalProperties: false,
        },
        SqlBulkInsertParams: {
          type: "object",
          required: ["table", "columns", "rows"],
          description:
            "Native ODBC bulk insert params. Each row must have the same length and order as columns.",
          properties: {
            table: { type: "string", minLength: 1 },
            columns: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/SqlBulkInsertColumn" },
            },
            rows: {
              type: "array",
              minItems: 1,
              items: {
                type: "array",
                items: {},
              },
            },
            client_token: { type: "string", minLength: 1 },
            clientToken: { type: "string", minLength: 1 },
            auth: { type: "string", minLength: 1 },
            idempotency_key: { type: "string", minLength: 1 },
            database: { type: "string", minLength: 1 },
            options: { $ref: "#/components/schemas/SqlBulkInsertOptions" },
          },
          additionalProperties: false,
        },
        SqlCancelParams: {
          type: "object",
          properties: {
            execution_id: { type: "string", minLength: 1 },
            request_id: { type: "string", minLength: 1 },
          },
          anyOf: [{ required: ["execution_id"] }, { required: ["request_id"] }],
          additionalProperties: false,
        },
        RpcDiscoverParams: {
          type: "object",
          additionalProperties: true,
          description: `Optional free-form params; serialized JSON max ${AGENT_RPC_DISCOVER_PARAMS_JSON_MAX_BYTES} UTF-8 bytes (Zod).`,
        },
        RpcClientTokenCarrierParams: {
          type: "object",
          additionalProperties: false,
          properties: {
            client_token: { type: "string", minLength: 1 },
            clientToken: { type: "string", minLength: 1 },
            auth: { type: "string", minLength: 1 },
          },
          description: `Optional client_token / clientToken / auth aliases accepted by agent.getHealth, agent.getProfile and client_token.getPolicy; serialized JSON max ${AGENT_CLIENT_TOKEN_CARRIER_PARAMS_JSON_MAX_BYTES} UTF-8 bytes (Zod).`,
        },
        AgentGetProfileParams: {
          allOf: [{ $ref: "#/components/schemas/RpcClientTokenCarrierParams" }],
          description: "Deprecated OpenAPI alias for RpcClientTokenCarrierParams.",
        },
        RpcSqlExecuteCommand: {
          type: "object",
          required: ["method", "params"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["sql.execute"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/SqlExecuteParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcSqlExecuteBatchCommand: {
          type: "object",
          required: ["method", "params"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["sql.executeBatch"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/SqlExecuteBatchParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcSqlBulkInsertCommand: {
          type: "object",
          required: ["method", "params"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["sql.bulkInsert"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/SqlBulkInsertParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcSqlCancelCommand: {
          type: "object",
          required: ["method", "params"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["sql.cancel"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/SqlCancelParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcDiscoverCommand: {
          type: "object",
          required: ["method"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["rpc.discover"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/RpcDiscoverParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcAgentGetHealthCommand: {
          type: "object",
          required: ["method"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["agent.getHealth"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/RpcClientTokenCarrierParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcAgentGetProfileCommand: {
          type: "object",
          required: ["method"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["agent.getProfile"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/RpcClientTokenCarrierParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        RpcClientTokenGetPolicyCommand: {
          type: "object",
          required: ["method"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            method: { type: "string", enum: ["client_token.getPolicy"] },
            id: { $ref: "#/components/schemas/JsonRpcId" },
            params: { $ref: "#/components/schemas/RpcClientTokenCarrierParams" },
            api_version: { type: "string", minLength: 1 },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
          additionalProperties: true,
        },
        BridgeSingleCommand: {
          oneOf: [
            { $ref: "#/components/schemas/RpcAgentGetHealthCommand" },
            { $ref: "#/components/schemas/RpcAgentGetProfileCommand" },
            { $ref: "#/components/schemas/RpcClientTokenGetPolicyCommand" },
            { $ref: "#/components/schemas/RpcSqlExecuteCommand" },
            { $ref: "#/components/schemas/RpcSqlExecuteBatchCommand" },
            { $ref: "#/components/schemas/RpcSqlBulkInsertCommand" },
            { $ref: "#/components/schemas/RpcSqlCancelCommand" },
            { $ref: "#/components/schemas/RpcDiscoverCommand" },
          ],
        },
        BridgeBatchCommand: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { $ref: "#/components/schemas/BridgeSingleCommand" },
        },
        BridgeCommand: {
          description:
            "Single JSON-RPC object or batch array (max 32). Missing id is auto-filled with a UUID by the server for REST and agents:command; use id: null for fire-and-forget notifications.",
          oneOf: [
            { $ref: "#/components/schemas/BridgeSingleCommand" },
            { $ref: "#/components/schemas/BridgeBatchCommand" },
          ],
        },
        AgentCommandPagination: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: AGENT_PAGE_SIZE_LIMIT },
            cursor: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
          description:
            "Supported only for single sql.execute and translated to command.params.options (page_size/cursor).",
        },
        AgentCommandRequest: {
          type: "object",
          required: ["agentId", "command"],
          properties: {
            agentId: {
              type: "string",
              minLength: 1,
              example: "3183a9f2-429b-46d6-a339-3580e5e5cb31",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1,
              maximum: 360_000,
              example: 15000,
              description:
                "Max wait for agent response (ms). Raised automatically toward SQL command options.timeout_ms when higher.",
            },
            pagination: { $ref: "#/components/schemas/AgentCommandPagination" },
            command: { $ref: "#/components/schemas/BridgeCommand" },
            payloadFrameCompression: {
              type: "string",
              enum: ["default", "none", "always"],
              description: `Optional gzip for hub-originated PayloadFrames on \`rpc:request\` to the agent. \`default\`: above ${HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES} bytes, gzip only if smaller than raw JSON (auto, aligned with plug_agente). \`none\`: never gzip. \`always\`: prefer gzip whenever eligible (always_gzip), even if compressed size is larger, but never emit a frame that exceeds the negotiated inflation-ratio guard.`,
            },
          },
          additionalProperties: false,
        },
        NormalizedRpcError: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "integer" },
            message: { type: "string" },
            data: {},
          },
        },
        NormalizedRpcItem: {
          type: "object",
          required: ["id", "success"],
          properties: {
            id: { $ref: "#/components/schemas/JsonRpcId" },
            success: { type: "boolean" },
            result: {},
            error: { $ref: "#/components/schemas/NormalizedRpcError" },
            api_version: { type: "string" },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
        },
        NormalizedRpcSingleResponse: {
          type: "object",
          required: ["type", "success", "item"],
          properties: {
            type: { type: "string", enum: ["single"] },
            success: { type: "boolean" },
            item: { $ref: "#/components/schemas/NormalizedRpcItem" },
            api_version: { type: "string" },
            meta: { $ref: "#/components/schemas/RpcMeta" },
          },
        },
        NormalizedRpcBatchResponse: {
          type: "object",
          required: ["type", "success", "items"],
          properties: {
            type: { type: "string", enum: ["batch"] },
            success: { type: "boolean" },
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/NormalizedRpcItem" },
            },
          },
        },
        NormalizedRpcRawResponse: {
          type: "object",
          required: ["type", "success", "payload"],
          properties: {
            type: { type: "string", enum: ["raw"] },
            success: { type: "boolean", enum: [false] },
            payload: {},
          },
        },
        NormalizedAgentRpcResponse: {
          oneOf: [
            { $ref: "#/components/schemas/NormalizedRpcSingleResponse" },
            { $ref: "#/components/schemas/NormalizedRpcBatchResponse" },
            { $ref: "#/components/schemas/NormalizedRpcRawResponse" },
          ],
        },
        AgentCommandResponse200: {
          type: "object",
          required: ["mode", "agentId", "requestId", "response"],
          properties: {
            mode: { type: "string", example: "bridge" },
            agentId: { type: "string" },
            requestId: { type: "string" },
            response: { $ref: "#/components/schemas/NormalizedAgentRpcResponse" },
          },
        },
        AgentCommandResponse202: {
          type: "object",
          required: ["mode", "agentId", "requestId", "notification", "acceptedCommands"],
          properties: {
            mode: { type: "string", example: "bridge" },
            agentId: { type: "string" },
            requestId: { type: "string" },
            notification: { type: "boolean", example: true },
            acceptedCommands: { type: "integer", minimum: 1, example: 1 },
          },
        },
        AgentAddress: {
          type: "object",
          required: ["street", "number", "district", "postalCode", "city", "state"],
          properties: {
            street: { type: "string", nullable: true, maxLength: 120 },
            number: { type: "string", nullable: true, maxLength: 20 },
            district: { type: "string", nullable: true, maxLength: 120 },
            postalCode: { type: "string", nullable: true, maxLength: 20 },
            city: { type: "string", nullable: true, maxLength: 120 },
            state: { type: "string", nullable: true, maxLength: 2 },
          },
        },
        AgentCatalogRecord: {
          type: "object",
          required: ["agentId", "name", "status", "profileVersion", "createdAt", "updatedAt"],
          properties: {
            agentId: { type: "string", format: "uuid" },
            name: { type: "string", maxLength: 120 },
            tradeName: { type: "string", nullable: true, maxLength: 120 },
            document: {
              type: "string",
              nullable: true,
              description: "Agent registration document (CPF/CNPJ when available).",
            },
            cnpjCpf: {
              type: "string",
              nullable: true,
              description: "Legacy alias for document.",
            },
            documentType: { type: "string", enum: ["cpf", "cnpj"], nullable: true },
            phone: { type: "string", nullable: true, maxLength: 20 },
            mobile: { type: "string", nullable: true, maxLength: 20 },
            email: { type: "string", nullable: true, format: "email" },
            address: { $ref: "#/components/schemas/AgentAddress" },
            notes: { type: "string", nullable: true, maxLength: 2000 },
            observation: { type: "string", nullable: true, maxLength: 2000 },
            lastLoginUserId: { type: "string", format: "uuid", nullable: true },
            profileUpdatedAt: { type: "string", format: "date-time", nullable: true },
            profileVersion: {
              type: "integer",
              minimum: 0,
              description: "Monotonic profile revision counter on the server.",
            },
            status: { type: "string", enum: ["active", "inactive"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AgentSelfProfilePatchRequest: {
          type: "object",
          description:
            "Partial self-service agent profile update. Omitted fields keep their current value; null clears optional fields.",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            tradeName: { type: "string", nullable: true, maxLength: 120 },
            document: {
              type: "string",
              nullable: true,
              maxLength: 40,
              description:
                "When set, must normalize to a valid Brazilian CPF (11 digits) or CNPJ (14 digits) with correct check digits; punctuation is stripped before validation and storage.",
            },
            documentType: { type: "string", enum: ["cpf", "cnpj"], nullable: true },
            phone: { type: "string", nullable: true, maxLength: 20 },
            mobile: { type: "string", nullable: true, maxLength: 20 },
            email: { type: "string", nullable: true, format: "email", maxLength: 255 },
            address: {
              nullable: true,
              allOf: [{ $ref: "#/components/schemas/AgentAddress" }],
            },
            notes: { type: "string", nullable: true, maxLength: 2000 },
            expectedProfileVersion: {
              type: "integer",
              minimum: 0,
              description:
                "Optional CAS token: must match current server profileVersion or the request is rejected with 409.",
            },
            idempotencyKey: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description:
                "Optional idempotency key when the Idempotency-Key header is not used. Prefer the header for HTTP clients.",
            },
          },
        },
        UserAgentEnriched: {
          type: "object",
          required: ["agentId", "name", "status"],
          properties: {
            agentId: { type: "string", format: "uuid" },
            name: { type: "string" },
            tradeName: { type: "string", nullable: true },
            document: { type: "string", nullable: true },
            notes: { type: "string", nullable: true },
            cnpjCpf: { type: "string", nullable: true },
            observation: { type: "string", nullable: true },
            status: { type: "string", enum: ["active", "inactive"] },
          },
        },
        ClientAccessibleAgent: {
          type: "object",
          required: [
            "agentId",
            "name",
            "status",
            "profileVersion",
            "createdAt",
            "updatedAt",
            "isHubConnected",
            "hasClientToken",
          ],
          properties: {
            agentId: { type: "string", format: "uuid" },
            name: { type: "string" },
            tradeName: { type: "string", nullable: true },
            document: { type: "string", nullable: true },
            cnpjCpf: { type: "string", nullable: true },
            documentType: { type: "string", enum: ["cpf", "cnpj"], nullable: true },
            phone: { type: "string", nullable: true },
            mobile: { type: "string", nullable: true },
            email: { type: "string", nullable: true, format: "email" },
            address: { $ref: "#/components/schemas/AgentAddress" },
            notes: { type: "string", nullable: true },
            observation: { type: "string", nullable: true },
            profileUpdatedAt: { type: "string", format: "date-time", nullable: true },
            profileVersion: {
              type: "integer",
              minimum: 0,
              description: "Monotonic profile revision counter on the server.",
            },
            status: { type: "string", enum: ["active", "inactive"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            isHubConnected: {
              type: "boolean",
              description:
                "Snapshot at response time: whether this hub process currently has this agent registered on the /agents Socket.IO namespace after agent:register. May change between polls; with refresh=true the value reflects the registry after any live profile work for that request. Per-process: false if the agent is connected only to another replica or not registered on this instance. Not the same as catalog status (active/inactive). When `HUB_INSTANCE_ID` is set, every Express response (REST, Swagger, /metrics, 404) carries header `X-Hub-Instance-Id` for sticky-session validation and replica correlation.",
            },
            hasClientToken: {
              type: "boolean",
              description:
                "Whether the authenticated client has stored a per-(client, agent) bearer token (used as `sql.execute params.client_token`). The actual value is **not** returned by listing/detail endpoints — fetch it via `GET /client/me/agents/{agentId}/client-token`.",
            },
          },
        },
        ClientAgentTokenRequest: {
          type: "object",
          required: ["clientToken"],
          properties: {
            clientToken: {
              description:
                "Bearer token used by the SQL bridge to authorize this client on the agent. Pass `null` (or an empty string, normalized to `null`) to clear the stored token.",
              oneOf: [
                {
                  type: "string",
                  minLength: 1,
                  maxLength: 512,
                  description: "Replace the stored token.",
                },
                { type: "null", description: "Clear the stored token." },
              ],
            },
          },
        },
        ClientAgentTokenResponse: {
          type: "object",
          required: ["agentId", "clientToken"],
          properties: {
            agentId: { type: "string", format: "uuid" },
            clientToken: {
              description: "Currently stored token. `null` when no token is configured.",
              oneOf: [{ type: "string", minLength: 1, maxLength: 512 }, { type: "null" }],
            },
          },
        },
        ClientAgentAccessRequestRecord: {
          type: "object",
          required: [
            "id",
            "clientId",
            "agentId",
            "status",
            "retryCount",
            "requestedAt",
            "createdAt",
            "updatedAt",
          ],
          description:
            "A client-to-agent access request with its current status and retry counter.",
          properties: {
            id: { type: "string", format: "uuid" },
            clientId: { type: "string", format: "uuid" },
            agentId: { type: "string", format: "uuid" },
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected", "expired", "revoked"],
            },
            retryCount: {
              type: "integer",
              minimum: 0,
              description:
                "Number of times the client has retried this request after rejection/expiry/revocation. Blocked at CLIENT_AGENT_ACCESS_MAX_RETRIES (default 5; 0 = unlimited).",
            },
            decidedAt: { type: "string", format: "date-time", nullable: true },
            decisionReason: { type: "string", nullable: true },
            requestedAt: { type: "string", format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            agentName: {
              type: "string",
              nullable: true,
              description: "Agent name (when enriched by repository).",
            },
          },
        },
        PaginatedAgentCatalogResponse: {
          type: "object",
          required: ["agents", "count", "total", "page", "pageSize"],
          properties: {
            agents: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentCatalogRecord" },
            },
            count: { type: "integer" },
            total: { type: "integer" },
            page: { type: "integer", minimum: 1 },
            pageSize: { type: "integer", minimum: 1 },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        ValidationError: {
          description: "Validation error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ValidationErrorResponse" },
            },
          },
        },
        Forbidden: {
          description:
            "Forbidden (insufficient permissions or business rule such as agent access denied)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        NotFound: {
          description: "Resource not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        Conflict: {
          description:
            "Conflict (e.g. duplicate agentId or document, agent profile CAS / idempotency mismatch, or registration state conflict). Duplicate CPF/CNPJ across agents returns `code` `AGENT_DOCUMENT_CONFLICT`.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        TooManyRequests: {
          description:
            "Rate limit exceeded (HTTP 429). Response body follows `ErrorResponse`; the server may include a `Retry-After` header.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        ServiceUnavailable: {
          description:
            "Service unavailable (HTTP 503). Returned when the agent is offline for pure-notification commands, the hub-to-agent transport timed out, or the server is overloaded. May include a `Retry-After` header with the suggested retry delay in seconds.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
    security: [],
  },
  apis: routeDocGlobs,
});

type OpenApiOperation = {
  servers?: Array<{ url: string; description?: string }>;
};

type OpenApiPathItem = Partial<
  Record<"get" | "post" | "put" | "patch" | "delete" | "options" | "head", OpenApiOperation>
>;

/**
 * `swagger-jsdoc` types its return value as the loose `object`, which makes
 * `swaggerSpec.paths` a TS error. The runtime shape is the OpenAPI document we
 * authored above, so we narrow it to the fields we actually touch.
 */
interface OpenApiSpecRuntime {
  paths?: Record<string, unknown>;
}

const compatAliasServers = [
  { url: "/api/v1", description: "Primary API base" },
  {
    url: "/",
    description: "Compatibility aliases (supported only for `/auth/*` and `/metrics`)",
  },
] as const;

/**
 * The app mounts `/auth/*` and `/metrics` both under `/api/v1` and at the root
 * for backward compatibility. Document those aliases with operation-level
 * servers, without implying that the whole API is available at `/`.
 */
for (const [pathKey, pathItem] of Object.entries((swaggerSpec as OpenApiSpecRuntime).paths ?? {})) {
  if (pathKey !== "/metrics" && !pathKey.startsWith("/auth/")) {
    continue;
  }
  const item = pathItem as OpenApiPathItem;
  for (const method of ["get", "post", "put", "patch", "delete", "options", "head"] as const) {
    const operation = item[method];
    if (!operation) {
      continue;
    }
    operation.servers = [...compatAliasServers];
  }
}

export const setupSwagger = (app: Express): void => {
  if (!env.swaggerEnabled) {
    return;
  }

  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        tryItOutEnabled: false,
      },
      customSiteTitle: `${env.appName} API Docs`,
      customfavIcon: "/assets/icons/favicon.ico",
    }),
  );

  app.get("/docs.json", (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "public, max-age=300");
    response.send(swaggerSpec);
  });
};
