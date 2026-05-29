import { describe, expect, it } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import {
  relayRpcRefundableBadRequest,
  validateAndNormalizeRelayCommand,
} from "../../../../../src/presentation/socket/hub/relay/relay_command_validation";

const expectRefundableBadRequest = (run: () => unknown, messagePattern: RegExp): void => {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  if (caught instanceof AppError) {
    expect(caught.statusCode).toBe(400);
    expect(caught.message).toMatch(messagePattern);
    expect(caught.details).toEqual({ refundRelayRpcRequestRateLimit: true });
  }
};

describe("relayRpcRefundableBadRequest", () => {
  it("builds a 400 carrying the relay rate-limit refund detail", () => {
    const error = relayRpcRefundableBadRequest("boom");
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("boom");
    expect(error.details).toEqual({ refundRelayRpcRequestRateLimit: true });
  });
});

describe("validateAndNormalizeRelayCommand", () => {
  it("rejects non-object payloads", () => {
    expectRefundableBadRequest(
      () => validateAndNormalizeRelayCommand(42),
      /must contain a JSON object payload/i,
    );
    expectRefundableBadRequest(
      () => validateAndNormalizeRelayCommand(null),
      /must contain a JSON object payload/i,
    );
  });

  it("rejects unsupported RPC methods", () => {
    expectRefundableBadRequest(
      () =>
        validateAndNormalizeRelayCommand({
          jsonrpc: "2.0",
          method: "totally.bogus",
          id: "req-1",
          params: {},
        }),
      /Unsupported RPC method/i,
    );
  });

  it("rejects JSON-RPC notifications (`id: null`)", () => {
    expectRefundableBadRequest(
      () =>
        validateAndNormalizeRelayCommand({
          jsonrpc: "2.0",
          method: "sql.execute",
          id: null,
          params: { sql: "SELECT 1" },
        }),
      /does not support JSON-RPC notifications/i,
    );
  });

  it("rejects schema-invalid commands with a refundable bad request", () => {
    // `sql.execute` requires params.sql; omitting it triggers a deep schema failure.
    expectRefundableBadRequest(
      () =>
        validateAndNormalizeRelayCommand({
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "req-1",
          params: {},
        }),
      /.+/,
    );
  });

  it("returns the parsed and normalized command for a valid request", () => {
    const { command, normalizedCommand } = validateAndNormalizeRelayCommand({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "req-valid",
      params: { sql: "SELECT 1" },
    });

    expect((command as { id?: unknown }).id).toBe("req-valid");
    expect((command as { method?: unknown }).method).toBe("sql.execute");
    expect(normalizedCommand).toBeDefined();
    expect((normalizedCommand as { method?: unknown }).method).toBe("sql.execute");
  });
});
