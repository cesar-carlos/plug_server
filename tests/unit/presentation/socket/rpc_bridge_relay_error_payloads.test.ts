import { describe, expect, it } from "vitest";

import {
  createRelayBatchResponseUnsupportedPayload,
  createRelayDecodeFailurePayload,
  createRelayUnexpectedFailurePayload,
} from "../../../../src/presentation/socket/hub/relay/rpc_bridge_relay_error_payloads";

type RpcError = {
  jsonrpc: string;
  id: string;
  error: { code: number; message: string; data: Record<string, unknown> };
};

describe("createRelayDecodeFailurePayload", () => {
  it("maps signature failures to -32001 / invalid_signature (auth, non-retryable)", () => {
    const payload = createRelayDecodeFailurePayload(
      "req-1",
      "PayloadFrame signature verification failed",
      "body-1",
    ) as RpcError;

    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.id).toBe("body-1");
    expect(payload.error.code).toBe(-32001);
    expect(payload.error.data).toMatchObject({
      reason: "invalid_signature",
      category: "auth",
      retryable: false,
      correlation_id: "corr-req-1",
      technical_message: "PayloadFrame signature verification failed",
    });
    expect(typeof payload.error.data.timestamp).toBe("string");
  });

  it("maps decompression failures to -32011 / compression_failed", () => {
    const payload = createRelayDecodeFailurePayload(
      "req-2",
      "Failed to decompress PayloadFrame payload",
      "body-2",
    ) as RpcError;

    expect(payload.error.code).toBe(-32011);
    expect(payload.error.data).toMatchObject({
      reason: "compression_failed",
      category: "transport",
      retryable: false,
    });
  });

  it("maps JSON decode failures to -32010 / decoding_failed", () => {
    const payload = createRelayDecodeFailurePayload(
      "req-3",
      "Could not decode PayloadFrame JSON payload",
      "body-3",
    ) as RpcError;

    expect(payload.error.code).toBe(-32010);
    expect(payload.error.data).toMatchObject({ reason: "decoding_failed" });
  });

  it("falls back to -32009 / invalid_payload for unrecognized reasons", () => {
    const payload = createRelayDecodeFailurePayload(
      "req-4",
      "something else",
      "body-4",
    ) as RpcError;

    expect(payload.error.code).toBe(-32009);
    expect(payload.error.data).toMatchObject({
      reason: "invalid_payload",
      category: "transport",
      retryable: false,
    });
  });

  it("matches the reason substrings case-insensitively", () => {
    const payload = createRelayDecodeFailurePayload(
      "req-5",
      "INVALID SIGNATURE detected",
      "body-5",
    ) as RpcError;
    expect(payload.error.code).toBe(-32001);
  });
});

describe("createRelayUnexpectedFailurePayload", () => {
  it("builds a retryable internal bridge error (-32000)", () => {
    const payload = createRelayUnexpectedFailurePayload("body-6", "boom") as RpcError;
    expect(payload.id).toBe("body-6");
    expect(payload.error.code).toBe(-32000);
    expect(payload.error.data).toMatchObject({
      code: "BRIDGE_INBOUND_PROCESSING_FAILED",
      retryable: true,
      technical_message: "boom",
    });
  });
});

describe("createRelayBatchResponseUnsupportedPayload", () => {
  it("builds a non-retryable -32009 batch-unsupported error", () => {
    const payload = createRelayBatchResponseUnsupportedPayload("body-7") as RpcError;
    expect(payload.id).toBe("body-7");
    expect(payload.error.code).toBe(-32009);
    expect(payload.error.data).toMatchObject({
      code: "RELAY_BATCH_RESPONSE_UNSUPPORTED",
      retryable: false,
    });
  });
});
