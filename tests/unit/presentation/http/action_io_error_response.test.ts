import { expect, it } from "vitest";
import { buildHttpErrorResponseBody } from "../../../../src/presentation/http/helpers/http_error_response";

it("preserves safe action reconciliation metadata in production without leaking private details", () => {
  const result = buildHttpErrorResponseBody({
    code: "ACTION_OUTCOME_UNKNOWN",
    message: "Reconcile the execution",
    exposeDetails: false,
    details: {
      diagnostic_id: "diag-1",
      effects_possible: true,
      recovery: "query_execution",
      confirmed_bytes: null,
      command_line: "secret",
      payload: "secret",
      stack: "secret",
    },
  });
  expect(result.error.details).toEqual({
    diagnostic_id: "diag-1",
    effects_possible: true,
    recovery: "query_execution",
    confirmed_bytes: null,
  });
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("does not broaden public details for unrelated failures", () => {
  const result = buildHttpErrorResponseBody({
    code: "INTERNAL_SERVER_ERROR",
    message: "Failed",
    exposeDetails: false,
    details: { diagnostic_id: "private" },
  });
  expect(result.error).not.toHaveProperty("details");
});

it("never falls back to arbitrary action details even in development", () => {
  const result = buildHttpErrorResponseBody({
    code: "ACTION_IO_FAILURE",
    message: "Failed",
    exposeDetails: true,
    details: { payload: "private" },
  });
  expect(result.error).not.toHaveProperty("details");
});
