export const errorSchemas = {
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
} as const;

export const errorResponses = {
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
} as const;
