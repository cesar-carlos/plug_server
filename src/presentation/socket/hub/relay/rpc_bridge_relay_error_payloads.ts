/**
 * Pure builders for the synthetic JSON-RPC error envelopes the relay emits to a
 * consumer when an inbound agent response cannot be decoded, fails unexpectedly,
 * or violates a relay constraint.
 *
 * Extracted verbatim from the `createRpcBridgeAgentInboundHandlers` closure
 * (which had grown past 1.3k lines) so these mappings are unit-testable in
 * isolation. They are pure: output depends only on the arguments plus the
 * current timestamp.
 */

/**
 * Maps a decode/verify failure reason to the matching JSON-RPC error envelope.
 * The reason string is matched case-insensitively against known substrings
 * (signature, decompression, JSON decoding); anything else falls back to a
 * generic `invalid_payload` (`-32009`).
 */
export const createRelayDecodeFailurePayload = (
  requestId: string,
  reasonMessage: string,
  bodyId: string,
): Record<string, unknown> => {
  const timestamp = new Date().toISOString();
  const normalized = reasonMessage.toLowerCase();
  if (normalized.includes("signature")) {
    return {
      jsonrpc: "2.0",
      id: bodyId,
      error: {
        code: -32001,
        message: "Authentication failed",
        data: {
          reason: "invalid_signature",
          category: "auth",
          retryable: false,
          user_message: "Não foi possível autenticar a resposta do agente.",
          technical_message: reasonMessage,
          correlation_id: `corr-${requestId}`,
          timestamp,
        },
      },
    };
  }
  if (normalized.includes("decompress payloadframe payload")) {
    return {
      jsonrpc: "2.0",
      id: bodyId,
      error: {
        code: -32011,
        message: "Compression failed",
        data: {
          reason: "compression_failed",
          category: "transport",
          retryable: false,
          user_message: "Não foi possível descomprimir a resposta do agente.",
          technical_message: reasonMessage,
          correlation_id: `corr-${requestId}`,
          timestamp,
        },
      },
    };
  }
  if (normalized.includes("decode payloadframe json payload")) {
    return {
      jsonrpc: "2.0",
      id: bodyId,
      error: {
        code: -32010,
        message: "Decoding failed",
        data: {
          reason: "decoding_failed",
          category: "transport",
          retryable: false,
          user_message: "Não foi possível decodificar a resposta do agente.",
          technical_message: reasonMessage,
          correlation_id: `corr-${requestId}`,
          timestamp,
        },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: bodyId,
    error: {
      code: -32009,
      message: "Invalid payload",
      data: {
        reason: "invalid_payload",
        category: "transport",
        retryable: false,
        user_message: "O agente respondeu com um payload invalido.",
        technical_message: reasonMessage,
        correlation_id: `corr-${requestId}`,
        timestamp,
      },
    },
  };
};

/** Envelope for an unexpected (retryable) failure while processing inbound bridge traffic. */
export const createRelayUnexpectedFailurePayload = (
  bodyId: string,
  reasonMessage: string,
): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id: bodyId,
  error: {
    code: -32000,
    message: "Internal bridge error",
    data: {
      code: "BRIDGE_INBOUND_PROCESSING_FAILED",
      retryable: true,
      technical_message: reasonMessage,
    },
  },
});

/** Envelope returned when an agent sends a batch `rpc:response`, which the relay does not support. */
export const createRelayBatchResponseUnsupportedPayload = (
  bodyId: string,
): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id: bodyId,
  error: {
    code: -32009,
    message: "Relay does not support batch rpc:response",
    data: {
      code: "RELAY_BATCH_RESPONSE_UNSUPPORTED",
      retryable: false,
    },
  },
});
