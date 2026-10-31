export const actionIoBridgeSchemas = {
  ActionIoConfiguration: {
    description:
      "I/O v1 contract. Requires explicit negotiation and faithful authorization. Schema presence does not enable runtime support.",
    type: "object",
    properties: {
      version: {
        type: "integer", enum: [1],
      },
      mode: {
        type: "string", enum: ["faithful"],
      },
      close_input: {
        type: "boolean",
      },
      initial_input_base64: {
        type: "string",
        maxLength: 87384,
        pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
      },
    },
    required: ["version", "mode", "close_input"],
    additionalProperties: false,
  },
  ActionIoSendInputParams: {
    description:
      "I/O v1 contract. Requires explicit negotiation and faithful authorization. Schema presence does not enable runtime support.",
    type: "object",
    properties: {
      client_token: {
        type: "string",
        minLength: 1,
      },
      clientToken: {
        type: "string",
        minLength: 1,
      },
      auth: {
        type: "string",
        minLength: 1,
      },
      trace_id: {
        type: "string",
        minLength: 1,
      },
      requested_by: {
        type: "string",
        minLength: 1,
      },
      execution_id: {
        type: "string",
        minLength: 1,
      },
      message_id: {
        type: "string",
        minLength: 1,
      },
      sequence: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      data_base64: {
        type: "string",
        maxLength: 87384,
        pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
      },
    },
    required: ["execution_id", "message_id", "sequence", "data_base64"],
    additionalProperties: false,
  },
  RpcActionIoSendInputCommand: {
    properties: {
      params: {
        $ref: "#/components/schemas/ActionIoSendInputParams",
      },
      jsonrpc: {
        type: "string",
        enum: ["2.0"],
      },
      id: {
        oneOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "number",
          },
        ],
      },
      method: {
        type: "string",
        enum: ["agent.action.sendInput"],
      },
    },
    type: "object",
    description:
      "Requires negotiated agentActions.io v1; disabled by default. Schema availability is not operational acceptance.",
    additionalProperties: true,
    required: ["method", "id", "params"],
  },
  ActionIoCloseInputParams: {
    description:
      "I/O v1 contract. Requires explicit negotiation and faithful authorization. Schema presence does not enable runtime support.",
    type: "object",
    properties: {
      client_token: {
        type: "string",
        minLength: 1,
      },
      clientToken: {
        type: "string",
        minLength: 1,
      },
      auth: {
        type: "string",
        minLength: 1,
      },
      trace_id: {
        type: "string",
        minLength: 1,
      },
      requested_by: {
        type: "string",
        minLength: 1,
      },
      execution_id: {
        type: "string",
        minLength: 1,
      },
      message_id: {
        type: "string",
        minLength: 1,
      },
      sequence: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    },
    required: ["execution_id", "message_id", "sequence"],
    additionalProperties: false,
  },
  RpcActionIoCloseInputCommand: {
    properties: {
      params: {
        $ref: "#/components/schemas/ActionIoCloseInputParams",
      },
      jsonrpc: {
        type: "string",
        enum: ["2.0"],
      },
      id: {
        oneOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "number",
          },
        ],
      },
      method: {
        type: "string",
        enum: ["agent.action.closeInput"],
      },
    },
    type: "object",
    description:
      "Requires negotiated agentActions.io v1; disabled by default. Schema availability is not operational acceptance.",
    additionalProperties: true,
    required: ["method", "id", "params"],
  },
  ActionIoGetInputStatusParams: {
    description:
      "I/O v1 contract. Requires explicit negotiation and faithful authorization. Schema presence does not enable runtime support.",
    type: "object",
    properties: {
      client_token: {
        type: "string",
        minLength: 1,
      },
      clientToken: {
        type: "string",
        minLength: 1,
      },
      auth: {
        type: "string",
        minLength: 1,
      },
      trace_id: {
        type: "string",
        minLength: 1,
      },
      requested_by: {
        type: "string",
        minLength: 1,
      },
      execution_id: {
        type: "string",
        minLength: 1,
      },
      message_id: {
        type: "string",
        minLength: 1,
      },
    },
    required: ["execution_id", "message_id"],
    additionalProperties: false,
  },
  RpcActionIoGetInputStatusCommand: {
    properties: {
      params: {
        $ref: "#/components/schemas/ActionIoGetInputStatusParams",
      },
      jsonrpc: {
        type: "string",
        enum: ["2.0"],
      },
      id: {
        oneOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "number",
          },
        ],
      },
      method: {
        type: "string",
        enum: ["agent.action.getInputStatus"],
      },
    },
    type: "object",
    description:
      "Requires negotiated agentActions.io v1; disabled by default. Schema availability is not operational acceptance.",
    additionalProperties: true,
    required: ["method", "id", "params"],
  },
  ActionIoReadIoParams: {
    description:
      "I/O v1 contract. Requires explicit negotiation and faithful authorization. Schema presence does not enable runtime support.",
    type: "object",
    properties: {
      client_token: {
        type: "string",
        minLength: 1,
      },
      clientToken: {
        type: "string",
        minLength: 1,
      },
      auth: {
        type: "string",
        minLength: 1,
      },
      trace_id: {
        type: "string",
        minLength: 1,
      },
      requested_by: {
        type: "string",
        minLength: 1,
      },
      execution_id: {
        type: "string",
        minLength: 1,
      },
      after_sequence: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      max_bytes: {
        type: "integer",
        minimum: 65536,
        maximum: 262144,
      },
      wait_ms: {
        type: "integer",
        minimum: 0,
        maximum: 20000,
      },
    },
    required: ["execution_id", "after_sequence", "max_bytes", "wait_ms"],
    additionalProperties: false,
  },
  RpcActionIoReadIoCommand: {
    properties: {
      params: {
        $ref: "#/components/schemas/ActionIoReadIoParams",
      },
      jsonrpc: {
        type: "string",
        enum: ["2.0"],
      },
      id: {
        oneOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "number",
          },
        ],
      },
      method: {
        type: "string",
        enum: ["agent.action.readIo"],
      },
    },
    type: "object",
    description:
      "Requires negotiated agentActions.io v1; disabled by default. Schema availability is not operational acceptance.",
    additionalProperties: true,
    required: ["method", "id", "params"],
  },
  RpcActionCatalogCommand: {
    type: "object",
    description: "Requires negotiated catalog v1 and authorized Client. Read one page without executing any action.",
    required: ["id", "method", "params"],
    properties: {
      id: { oneOf: [{type:"string",minLength:1},{type:"number"}] },
      method: {type:"string",enum:["agent.action.listAvailable"]},
      params: {type:"object",additionalProperties:false,properties:{
        client_token:{type:"string",minLength:1,writeOnly:true}, clientToken:{type:"string",minLength:1,writeOnly:true},
        auth:{type:"string",minLength:1,writeOnly:true}, trace_id:{type:"string",minLength:1}, requested_by:{type:"string",minLength:1},
        page_size:{type:"integer",minimum:1,maximum:50},
        cursor:{type:"string",minLength:1,maxLength:128},
      }},
    },
  },
  ActionIoFindExecutionParams: {
    description:
      "I/O v1 contract. Requires explicit negotiation and faithful authorization. Schema presence does not enable runtime support.",
    type: "object",
    properties: {
      client_token: {
        type: "string",
        minLength: 1,
      },
      clientToken: {
        type: "string",
        minLength: 1,
      },
      auth: {
        type: "string",
        minLength: 1,
      },
      trace_id: {
        type: "string",
        minLength: 1,
      },
      requested_by: {
        type: "string",
        minLength: 1,
      },
      action_id: {
        type: "string",
        minLength: 1,
      },
      idempotency_key: {
        type: "string",
        minLength: 1,
      },
    },
    required: ["action_id", "idempotency_key"],
    additionalProperties: false,
  },
  RpcActionIoFindExecutionCommand: {
    properties: {
      params: {
        $ref: "#/components/schemas/ActionIoFindExecutionParams",
      },
      jsonrpc: {
        type: "string",
        enum: ["2.0"],
      },
      id: {
        oneOf: [
          {
            type: "string",
            minLength: 1,
          },
          {
            type: "number",
          },
        ],
      },
      method: {
        type: "string",
        enum: ["agent.action.findExecution"],
      },
    },
    type: "object",
    description:
      "Requires negotiated agentActions.io v1; disabled by default. Schema availability is not operational acceptance.",
    additionalProperties: true,
    required: ["method", "id", "params"],
  },
} as const;
