export const socketEventSchemas = {
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
} as const;
