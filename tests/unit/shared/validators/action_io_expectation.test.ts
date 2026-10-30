import { describe, expect, it } from "vitest";
import { captureActionIoExpectation } from "../../../../src/shared/validators/action_io_response_expectation";
import { isValidActionIoResponse } from "../../../../src/shared/validators/action_io_result";
const receipt = {
  execution_id: "e",
  message_id: "m",
  sequence: 0,
  state: "accepted",
  confirmed_bytes: 0,
  next_input_sequence: 1,
  stdin_state: "open",
};
describe("I/O request-bound response checks", () => {
  it("rejects a written receipt that confirms only part of the submitted block", () => {
    const expected = captureActionIoExpectation({
      method: "agent.action.sendInput",
      params: { data_base64: "AP8=" },
    });
    for (const confirmed_bytes of [0, 1, 2]) {
      expect(
        isValidActionIoResponse(
          "agent.action.sendInput",
          {
            result: { ...receipt, state: "written", confirmed_bytes },
          },
          expected,
        ),
      ).toBe(confirmed_bytes === 2);
    }
    expect(
      isValidActionIoResponse(
        "agent.action.sendInput",
        {
          result: { ...receipt, state: "unknown", confirmed_bytes: 1 },
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isValidActionIoResponse(
        "agent.action.sendInput",
        {
          result: { ...receipt, state: "written", confirmed_bytes: 0 },
        },
        { inputBytes: 0 },
      ),
    ).toBe(true);
  });
  it("rejects impossible confirmed byte counts without storing payloads", () => {
    const expected = captureActionIoExpectation({
      method: "agent.action.sendInput",
      params: { data_base64: "AA==" },
    });
    expect(
      isValidActionIoResponse(
        "agent.action.sendInput",
        { result: { ...receipt, state: "failed", confirmed_bytes: 2 } },
        expected,
      ),
    ).toBe(false);
    expect(
      isValidActionIoResponse(
        "agent.action.sendInput",
        { result: { ...receipt, state: "unknown", confirmed_bytes: null } },
        expected,
      ),
    ).toBe(true);
    const closing = captureActionIoExpectation({ method: "agent.action.closeInput", params: {} });
    expect(closing.inputBytes).toBe(0);
    expect(
      isValidActionIoResponse(
        "agent.action.closeInput",
        { result: { ...receipt, confirmed_bytes: 1 } },
        closing,
      ),
    ).toBe(false);
    expect(isValidActionIoResponse("agent.action.closeInput", { result: receipt }, closing)).toBe(
      true,
    );
  });
  it("captures only correlation metadata", () => {
    expect(
      captureActionIoExpectation({
        method: "agent.action.sendInput",
        params: {
          execution_id: "e",
          message_id: "m",
          sequence: 0,
          client_token: "secret",
          data_base64: "AA==",
        },
      }),
    ).toEqual({ executionId: "e", messageId: "m", sequence: 0, inputBytes: 1 });
  });
  it("rejects a valid receipt belonging to another request", () => {
    const expected = { executionId: "e", messageId: "m", sequence: 0 };
    expect(isValidActionIoResponse("agent.action.sendInput", { result: receipt }, expected)).toBe(
      true,
    );
    for (const patch of [{ execution_id: "other" }, { message_id: "other" }, { sequence: 1 }]) {
      expect(
        isValidActionIoResponse(
          "agent.action.sendInput",
          { result: { ...receipt, ...patch } },
          expected,
        ),
      ).toBe(false);
    }
  });
  it("rejects cursor rewinds and pages beyond the requested size", () => {
    const expected = { executionId: "e", afterSequence: 4, maxBytes: 65536 };
    const result = {
      execution_id: "e",
      events: [],
      next_sequence: 4,
      terminal: false,
      output_complete: false,
    };
    expect(isValidActionIoResponse("agent.action.readIo", { result }, expected)).toBe(true);
    expect(
      isValidActionIoResponse(
        "agent.action.readIo",
        { result: { ...result, next_sequence: 3 } },
        expected,
      ),
    ).toBe(false);
    const events = [5, 6].map((sequence) => ({
      type: "output",
      sequence,
      stream: "stdout",
      offset: 0,
      data_base64: Buffer.alloc(65536).toString("base64"),
    }));
    expect(
      isValidActionIoResponse(
        "agent.action.readIo",
        { result: { ...result, events, next_sequence: 6 } },
        expected,
      ),
    ).toBe(false);
  });
  it("leaves legitimate RPC errors to envelope validation", () => {
    expect(
      isValidActionIoResponse(
        "agent.action.sendInput",
        { error: { code: -32000, message: "Denied" } },
        { executionId: "e" },
      ),
    ).toBe(true);
  });
});
