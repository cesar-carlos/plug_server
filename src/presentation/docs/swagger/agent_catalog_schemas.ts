export const agentCatalogSchemas = {
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
} as const;
