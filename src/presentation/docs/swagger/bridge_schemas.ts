import {
  HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES,
  HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO,
} from "../../../shared/constants/agent_transport_contract";
import {
  AGENT_ACTION_GET_EXECUTION_MAX_OUTPUT_BYTES,
  AGENT_CLIENT_TOKEN_CARRIER_PARAMS_JSON_MAX_BYTES,
  AGENT_MAX_ROWS_LIMIT,
  AGENT_PAGE_SIZE_LIMIT,
  AGENT_RPC_DISCOVER_PARAMS_JSON_MAX_BYTES,
  AGENT_SQL_MAX_UTF8_BYTES,
  AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES,
  AGENT_TIMEOUT_MS_LIMIT,
} from "../../../shared/validators/agent_command";

export const bridgeSchemas = {
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
      prefer_db_streaming: {
        type: "boolean",
        description:
          "Pass-through preference for plug_agente direct DB streaming on eligible unpaginated SELECTs; final routing remains agent-side.",
      },
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
      max_parallel_read_only_batch_items: {
        type: "integer",
        minimum: 1,
        description:
          "Pass-through opt-in parallelism for non-transactional read-only SELECT batches; plug_agente applies its own safety cap.",
      },
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
  RpcAgentActionCorrelationParams: {
    type: "object",
    additionalProperties: false,
    properties: {
      trace_id: { type: "string", minLength: 1 },
      requested_by: { type: "string", minLength: 1 },
      client_token: { type: "string", minLength: 1 },
      clientToken: { type: "string", minLength: 1 },
      auth: { type: "string", minLength: 1 },
    },
    description: "Published correlation and token aliases for agent.action.* remote calls.",
  },
  AgentActionRunParams: {
    allOf: [
      { $ref: "#/components/schemas/RpcAgentActionCorrelationParams" },
      {
        type: "object",
        required: ["action_id", "idempotency_key"],
        properties: {
          action_id: { type: "string", minLength: 1 },
          idempotency_key: { type: "string", minLength: 1 },
          trigger_id: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
  },
  AgentActionValidateRunParams: {
    allOf: [
      { $ref: "#/components/schemas/RpcAgentActionCorrelationParams" },
      {
        type: "object",
        required: ["action_id", "idempotency_key"],
        properties: {
          action_id: { type: "string", minLength: 1 },
          idempotency_key: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
  },
  AgentActionCancelParams: {
    allOf: [
      { $ref: "#/components/schemas/RpcAgentActionCorrelationParams" },
      {
        type: "object",
        required: ["execution_id"],
        properties: {
          execution_id: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
  },
  AgentActionGetExecutionParams: {
    allOf: [
      { $ref: "#/components/schemas/RpcAgentActionCorrelationParams" },
      {
        type: "object",
        required: ["execution_id"],
        properties: {
          execution_id: { type: "string", minLength: 1 },
          include_output: { type: "boolean" },
          stdout_offset: { type: "integer", minimum: 0 },
          stdout_cursor: { type: "integer", minimum: 0 },
          output_offset: { type: "integer", minimum: 0 },
          stderr_offset: { type: "integer", minimum: 0 },
          stderr_cursor: { type: "integer", minimum: 0 },
          max_output_bytes: {
            type: "integer",
            minimum: 1,
            maximum: AGENT_ACTION_GET_EXECUTION_MAX_OUTPUT_BYTES,
          },
        },
        additionalProperties: false,
      },
    ],
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
  RpcAgentActionRunCommand: {
    type: "object",
    required: ["method", "params"],
    properties: {
      jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
      method: { type: "string", enum: ["agent.action.run"] },
      id: { $ref: "#/components/schemas/JsonRpcId" },
      params: { $ref: "#/components/schemas/AgentActionRunParams" },
      api_version: { type: "string", minLength: 1 },
      meta: { $ref: "#/components/schemas/RpcMeta" },
    },
    additionalProperties: true,
  },
  RpcAgentActionValidateRunCommand: {
    type: "object",
    required: ["method", "params"],
    properties: {
      jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
      method: { type: "string", enum: ["agent.action.validateRun"] },
      id: { $ref: "#/components/schemas/JsonRpcId" },
      params: { $ref: "#/components/schemas/AgentActionValidateRunParams" },
      api_version: { type: "string", minLength: 1 },
      meta: { $ref: "#/components/schemas/RpcMeta" },
    },
    additionalProperties: true,
  },
  RpcAgentActionCancelCommand: {
    type: "object",
    required: ["method", "params"],
    properties: {
      jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
      method: { type: "string", enum: ["agent.action.cancel"] },
      id: { $ref: "#/components/schemas/JsonRpcId" },
      params: { $ref: "#/components/schemas/AgentActionCancelParams" },
      api_version: { type: "string", minLength: 1 },
      meta: { $ref: "#/components/schemas/RpcMeta" },
    },
    additionalProperties: true,
  },
  RpcAgentActionGetExecutionCommand: {
    type: "object",
    required: ["method", "params"],
    properties: {
      jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
      method: { type: "string", enum: ["agent.action.getExecution"] },
      id: { $ref: "#/components/schemas/JsonRpcId" },
      params: { $ref: "#/components/schemas/AgentActionGetExecutionParams" },
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
      { $ref: "#/components/schemas/RpcAgentActionRunCommand" },
      { $ref: "#/components/schemas/RpcAgentActionValidateRunCommand" },
      { $ref: "#/components/schemas/RpcAgentActionCancelCommand" },
      { $ref: "#/components/schemas/RpcAgentActionGetExecutionCommand" },
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
} as const;
