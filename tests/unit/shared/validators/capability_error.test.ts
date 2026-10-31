import { expect, it } from "vitest";
import { capabilityUnavailable } from "../../../../src/shared/errors/capability_unavailable";
import { buildHttpErrorResponseBody } from "../../../../src/presentation/http/helpers/http_error_response";
it("preserves actionable capability diagnostics in production REST without exposing secrets", () => {
  const error = capabilityUnavailable("sqlOperations v1", "not_advertised");
  const body = buildHttpErrorResponseBody({
    code: error.code,
    message: error.message,
    details: { ...(error.details as object), token: "secret", technical_message: "private" },
  });
  expect(body.error.details).toEqual(error.details);
  expect(body.message).toContain("não foi encaminhada");
  expect(JSON.stringify(body)).not.toMatch(/secret|private/);
});
