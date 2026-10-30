import { expect, it } from "vitest";
import { captureActionIoExpectation } from "../../../../src/shared/validators/action_io_response_expectation";
import { isValidActionIoResponse } from "../../../../src/shared/validators/action_io_result";

it("refuses a faithful run response that omits execution metadata", () => {
  const expected = captureActionIoExpectation({
    method: "agent.action.run",
    params: { action_id: "a", io: { version: 1, mode: "faithful", close_input: false } },
  });
  expect(
    isValidActionIoResponse("agent.action.run", { result: { execution_id: "e" } }, expected),
  ).toBe(false);
});
it("refuses a faithful validateRun response that loses replay information", () => {
  const expected = captureActionIoExpectation({
    method: "agent.action.validateRun",
    params: { action_id: "a", io: { version: 1, mode: "faithful", close_input: false } },
  });
  expect(
    isValidActionIoResponse(
      "agent.action.validateRun",
      { result: { valid: true, action_id: "a", action_type: "executable" } },
      expected,
    ),
  ).toBe(false);
});
it("refuses malformed faithful getExecution responses without requiring I/O on legacy responses", () => {
  expect(
    isValidActionIoResponse("agent.action.getExecution", { result: { io: { mode: "faithful" } } }),
  ).toBe(false);
  expect(isValidActionIoResponse("agent.action.getExecution", { result: { legacy: true } })).toBe(
    true,
  );
});

const emptyOutput = {
  captured: false,
  truncated: false,
  utf8_total_bytes: 0,
  offset: 0,
  next_offset: 0,
  response_truncated: false,
};
const execution = {
  execution_id: "e",
  action_id: "a",
  action_type: "executable",
  status: "succeeded",
  source: "remoteHub",
  requested_at: "2026-10-29T00:00:00Z",
  timestamps: {},
  process: { exit_code: 0 },
  output: { stdout: emptyOutput, stderr: emptyOutput },
  flags: {
    terminal: true,
    skipped: false,
    timed_out: false,
    cancelled: false,
    killed: false,
    redaction_applied: true,
  },
  io: {
    version: 1,
    mode: "faithful",
    process_state: "finished",
    stdin_state: "closed",
    capture_state: "complete",
    output_expired: false,
    next_input_sequence: 2,
    initial_message_id: "system:initial",
    close_message_id: "system:close",
  },
};
it("accepts terminal run duplicates and refuses a mismatched action or malformed session", () => {
  const expected = captureActionIoExpectation({
    method: "agent.action.run",
    params: { action_id: "a", io: {} },
  });
  expect(isValidActionIoResponse("agent.action.run", { result: execution }, expected)).toBe(true);
  expect(
    isValidActionIoResponse(
      "agent.action.run",
      { result: { ...execution, action_id: "other" } },
      expected,
    ),
  ).toBe(false);
  expect(
    isValidActionIoResponse(
      "agent.action.run",
      { result: { ...execution, io: { ...execution.io, version: 2 } } },
      expected,
    ),
  ).toBe(false);
});
it("preserves dry-run replay fields and authentication errors", () => {
  const expected = captureActionIoExpectation({
    method: "agent.action.validateRun",
    params: { action_id: "a", io: {} },
  });
  expect(
    isValidActionIoResponse(
      "agent.action.validateRun",
      {
        result: {
          valid: true,
          action_id: "a",
          action_type: "executable",
          would_replay_existing_execution: true,
          existing_execution_id: "e",
        },
      },
      expected,
    ),
  ).toBe(true);
  expect(
    isValidActionIoResponse(
      "agent.action.validateRun",
      { error: { code: -32001, message: "Unauthorized" } },
      expected,
    ),
  ).toBe(true);
});
it("validates the nested execution of a faithful cancellation", () => {
  const expected = captureActionIoExpectation({
    method: "agent.action.cancel",
    params: { execution_id: "e" },
  });
  const result = {
    cancelled: false,
    execution_id: "e",
    status: "succeeded",
    reason: "cancel_requested",
    execution,
  };
  expect(isValidActionIoResponse("agent.action.cancel", { result }, expected)).toBe(true);
  expect(
    isValidActionIoResponse(
      "agent.action.cancel",
      { result: { ...result, execution: { ...execution, io: { mode: "faithful" } } } },
      expected,
    ),
  ).toBe(false);
});

it("rejects cancellation metadata for a different nested execution", () => {
  const expected = captureActionIoExpectation({
    method: "agent.action.cancel",
    params: { execution_id: "e" },
  });
  const result = {
    cancelled: false,
    execution_id: "e",
    status: "succeeded",
    reason: "cancel_requested",
    execution: { ...execution, execution_id: "other" },
  };
  expect(isValidActionIoResponse("agent.action.cancel", { result }, expected)).toBe(false);
});
