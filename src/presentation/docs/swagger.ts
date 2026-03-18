import type { Express } from "express";
import swaggerJSDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import path from "node:path";

import { env } from "../../shared/config/env";

const routeDocGlobs =
  env.nodeEnv === "production"
    ? [path.join(process.cwd(), "dist/presentation/http/routes/**/*.js")]
    : [path.join(process.cwd(), "src/presentation/http/routes/**/*.ts")];

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Plug Server API",
      version: "1.0.0",
      description:
        "REST API documentation for the Plug Server backend. The HTTP API fronts a dual-namespace Socket.IO architecture: agents connect to /agents, consumers to /consumers. The default namespace (/) is deprecated and rejects connections with app:error (code NAMESPACE_DEPRECATED). Compatibility aliases /auth/* and /metrics are also mounted at the root.",
    },
    servers: [
      {
        url: "/api/v1",
        description: "Current environment",
      },
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
          required: ["message", "code"],
          properties: {
            message: { type: "string", example: "Invalid or expired token" },
            code: { type: "string", example: "INVALID_TOKEN" },
            requestId: { type: "string", example: "0d2a9475-ccf8-4f03-a64c-ef75f9b2f5c6" },
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
        SocketBridgeSecurityNotes: {
          type: "object",
          description: "Security and transport hardening notes applied to HTTP-to-Socket bridge flow.",
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
              example: 20,
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
          nullable: true,
          oneOf: [{ type: "string", minLength: 1 }, { type: "number" }],
        },
        RpcMeta: {
          type: "object",
          properties: {
            trace_id: { type: "string" },
            traceparent: { type: "string" },
            tracestate: { type: "string" },
            request_id: { type: "string" },
            agent_id: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
          },
          additionalProperties: true,
        },
        SqlExecuteOptions: {
          type: "object",
          properties: {
            timeout_ms: { type: "integer", minimum: 1 },
            max_rows: { type: "integer", minimum: 1 },
            page: { type: "integer", minimum: 1 },
            page_size: { type: "integer", minimum: 1 },
            cursor: { type: "string", minLength: 1 },
            multi_result: { type: "boolean" },
          },
          additionalProperties: false,
        },
        SqlExecuteParams: {
          type: "object",
          required: ["sql"],
          properties: {
            sql: { type: "string", minLength: 1 },
            params: { type: "object", additionalProperties: true },
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
            sql: { type: "string", minLength: 1 },
            params: { type: "object", additionalProperties: true },
            execution_order: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        SqlExecuteBatchOptions: {
          type: "object",
          properties: {
            timeout_ms: { type: "integer", minimum: 1 },
            max_rows: { type: "integer", minimum: 1 },
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
        BridgeSingleCommand: {
          oneOf: [
            { $ref: "#/components/schemas/RpcSqlExecuteCommand" },
            { $ref: "#/components/schemas/RpcSqlExecuteBatchCommand" },
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
          oneOf: [
            { $ref: "#/components/schemas/BridgeSingleCommand" },
            { $ref: "#/components/schemas/BridgeBatchCommand" },
          ],
        },
        AgentCommandPagination: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 50000 },
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
            agentId: { type: "string", minLength: 1, example: "3183a9f2-429b-46d6-a339-3580e5e5cb31" },
            timeoutMs: { type: "integer", minimum: 1, maximum: 60000, example: 15000 },
            pagination: { $ref: "#/components/schemas/AgentCommandPagination" },
            command: { $ref: "#/components/schemas/BridgeCommand" },
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
      },
    },
    security: [],
  },
  apis: routeDocGlobs,
});

export const setupSwagger = (app: Express): void => {
  if (!env.swaggerEnabled) {
    return;
  }

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/docs.json", (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.send(swaggerSpec);
  });
};
