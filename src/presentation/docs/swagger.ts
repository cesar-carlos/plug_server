import type { Express } from "express";
import swaggerJSDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import path from "node:path";

import { env } from "../../shared/config/env";

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Plug Server API",
      version: "1.0.0",
      description: "REST API documentation for the Plug Server backend.",
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
          required: ["accessToken", "refreshToken"],
          properties: {
            accessToken: { type: "string" },
            refreshToken: { type: "string" },
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
  apis: [
    path.join(process.cwd(), "src/presentation/http/routes/**/*.ts"),
    path.join(process.cwd(), "dist/presentation/http/routes/**/*.js"),
  ],
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
