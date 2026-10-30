import { describe, expect, it } from "vitest";
import { captureActionIoBatch } from "../../../../src/shared/validators/action_io_response_expectation";
import { isValidActionIoBatchResponse } from "../../../../src/shared/validators/action_io_result";
const expected = captureActionIoBatch([
  {
    id: 1,
    method: "agent.action.readIo",
    params: { execution_id: "e", after_sequence: 4, max_bytes: 65536 },
  },
  {
    id: "1",
    method: "agent.action.findExecution",
    params: { action_id: "a", idempotency_key: "k" },
  },
]);
const page = {
  id: 1,
  result: {
    execution_id: "e",
    events: [],
    next_sequence: 4,
    terminal: false,
    output_complete: false,
  },
};
const found = { id: "1", result: { found: true, execution_id: "e" } };
describe("I/O batch result correlation", () => {
  it("accepts out-of-order results while distinguishing numeric and string IDs", () => {
    expect(isValidActionIoBatchResponse(expected, [found, page])).toBe(true);
  });
  it("rejects missing, duplicate, unknown and swapped responses", () => {
    for (const response of [
      [page],
      [page, page],
      [page, { ...found, id: "other" }],
      [
        { ...page, id: "1" },
        { ...found, id: 1 },
      ],
    ]) {
      expect(isValidActionIoBatchResponse(expected, response)).toBe(false);
    }
  });
  it("keeps legacy batches outside this extension", () => {
    expect(captureActionIoBatch([{ id: 1, method: "agent.getHealth" }])).toEqual([]);
    expect(isValidActionIoBatchResponse([], [{ id: 1, result: {} }])).toBe(true);
  });
});

it("checks faithful dry-run batches even without a readIo command", () => {
  const expectations = captureActionIoBatch([
    {
      id: 1,
      method: "agent.action.validateRun",
      params: { action_id: "a", io: { version: 1, mode: "faithful", close_input: false } },
    },
  ]);
  expect(
    isValidActionIoBatchResponse(expectations, [
      {
        id: 1,
        result: {
          valid: true,
          action_id: "other",
          action_type: "executable",
          would_replay_existing_execution: false,
        },
      },
    ]),
  ).toBe(false);
});
